/**
 * 文件系统操作模块：目录树、文件读写、精确替换与 AI Bridge 初始化。
 *
 * 本文件提供所有文件系统操作的纯业务实现。它不直接处理 MCP 协议或工具注册，
 * 而是被 server.ts 中的工具 handler 调用，形成清晰的分层架构。
 *
 * 安全约束：本文件中的所有函数都接受 PathGuard 和 Workspace 参数，
 * 不接受任意绝对路径输入。所有路径在传入底层 fs 模块前都必须经过 guard.resolve()
 * 或 guard.assertTextFile() 的校验，防止目录穿越和符号链接攻击。
 *
 * 上游调用者：src/server.ts（工具 handler）、src/workspaceOps.ts、src/proContext.ts
 * 下游依赖：node:fs、node:path、node:crypto、minimatch
 *
 * 主要能力：
 * - repoTree：构建目录树文本，用于 tree 工具
 * - listFiles：枚举文件列表，用于搜索操作
 * - readTextFile：读取文本文件（含行号展示和截断）
 * - writeTextFile：写入文件（含内容大小和密钥检测）
 * - editTextFile：精确文本替换（要求 old_text 唯一匹配）
 * - makeUnifiedDiff：生成 unified diff 用于变更预览
 * - ensureAiBridge：初始化 .ai-bridge 协作目录
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, displayPath, normalizeRelPath, PathGuard } from "./guard.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";

/** repoTree 函数的选项参数。 */
export interface TreeOptions {
  /** 要展示的子目录相对路径，默认为 "."（workspace 根目录）。 */
  path?: string;
  /** 最大递归深度。 */
  maxDepth: number;
  /** 是否包含以 . 开头的隐藏文件和目录。 */
  includeHidden: boolean;
  /** 最多展示的条目数（超过后截断）。 */
  maxEntries: number;
}

/** repoTree 的返回结果。 */
export interface TreeResult {
  /** 格式化的树形文本（适合直接插入 Markdown）。 */
  text: string;
  /** 实际包含的条目数（不含截断提示行）。 */
  entries: number;
  /** 是否因超过 maxEntries 而被截断。 */
  truncated: boolean;
}

/** readTextFile 的返回结果。 */
export interface ReadFileResult {
  /** 相对于 workspace root 的文件路径（正斜线格式）。 */
  path: string;
  /** 带行号的文件内容文本。 */
  text: string;
  /** 实际返回的起始行号（1-indexed）。 */
  startLine: number;
  /** 实际返回的结束行号（1-indexed）。 */
  endLine: number;
  /** 文件总行数。 */
  totalLines: number;
  /** 文件字节大小。 */
  bytes: number;
  /** 整个文件内容的 SHA-256 哈希值（用于并发安全检查）。 */
  sha256: string;
  /** 是否只返回了文件的部分内容（startLine > 1 或 endLine < totalLines）。 */
  truncated: boolean;
}

/** makeUnifiedDiff 和 writeTextFile/editTextFile 的 diff 结果。 */
export interface DiffResult {
  /** unified diff 格式的文本。 */
  diff: string;
  /** 新增行数。 */
  additions: number;
  /** 删除行数。 */
  deletions: number;
  /** 是否有实际变更（false 表示 old 和 new 完全相同）。 */
  changed: boolean;
}

/**
 * 计算字符串的 SHA-256 hex 摘要。
 *
 * 用于：
 * 1. readTextFile 返回文件内容的哈希，供调用方验证版本。
 * 2. writeTextFile 返回写入内容的哈希，用于确认写入成功。
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 计算用于文本类型探测的有界扫描窗口。
 *
 * 扫描上限高于普通读取上限，以便判断较大源码文件是否为文本；同时限制在 2 MB，
 * 避免为了类型探测读取过大的文件。若真实仓库需要更大范围，应新增独立配置项。
 */
export function textScanByteLimit(config: CodexProConfig): number {
  return Math.min(2_000_000, config.maxReadBytes * 4);
}

/**
 * 将文本内容按行拆分，统一处理 \r\n 和 \n 换行符。
 */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * 为文本行数组添加行号前缀，格式为 " N | content"。
 *
 * 行号宽度根据最大行号自动对齐，使显示结果整齐。
 * 这个格式让模型能精确引用行号，用于后续的 edit 操作。
 */
function withLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, idx) => `${String(startLine + idx).padStart(width, " ")} | ${line}`).join("\n");
}

/**
 * 生成两段文本之间的 unified diff。
 *
 * 实现说明：
 * - 先找公共前缀和后缀，只对变化的核心部分生成 diff（减少输出量）
 * - 在核心变化区域前后各保留 3 行上下文（标准 diff 习惯）
 * - diff 过长时截断，防止超出 maxChars 限制
 * - 输出前进行脱敏，防止 diff 中出现密钥
 *
 * @param oldText 修改前的文本
 * @param newText 修改后的文本
 * @param relPath 用于 diff 头部的文件相对路径
 * @param maxChars diff 文本的最大字符数
 */
export function makeUnifiedDiff(oldText: string, newText: string, relPath: string, maxChars = 60_000): DiffResult {
  if (oldText === newText) {
    return { diff: `No changes in ${relPath}.`, additions: 0, deletions: 0, changed: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const coreOldStart = prefix;
  const coreOldEnd = oldLines.length - suffix;
  const coreNewStart = prefix;
  const coreNewEnd = newLines.length - suffix;
  const context = 3;
  const oldStart = Math.max(0, coreOldStart - context);
  const oldEnd = Math.min(oldLines.length, coreOldEnd + context);
  const newStart = Math.max(0, coreNewStart - context);
  const newEnd = Math.min(newLines.length, coreNewEnd + context);

  const additions = Math.max(0, coreNewEnd - coreNewStart);
  const deletions = Math.max(0, coreOldEnd - coreOldStart);

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`];

  for (let i = oldStart; i < coreOldStart; i += 1) out.push(` ${oldLines[i]}`);
  for (let i = coreOldStart; i < coreOldEnd; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = coreNewStart; i < coreNewEnd; i += 1) out.push(`+${newLines[i]}`);
  for (let i = coreOldEnd; i < oldEnd; i += 1) out.push(` ${oldLines[i]}`);

  let diff = out.join("\n");
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars) + `\n...[diff truncated to ${maxChars} chars]`;
  }
  return { diff: redactSensitiveText(diff), additions, deletions, changed: true };
}

/**
 * 判断文件/目录名是否是隐藏项（以 . 开头，但不是 "." 或 ".."）。
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

/**
 * 构建目录树文本展示。
 *
 * 输出格式为 tree 命令风格的 ASCII 树，例如：
 * ```
 * .
 * ├── src/
 * │   ├── guard.ts
 * │   └── server.ts
 * └── package.json
 * ```
 *
 * 实现细节：
 * - 目录排在文件前面，便于整体把握结构
 * - blockedGlobs 命中的条目自动跳过（.git、node_modules 等）
 * - 超过 maxEntries 时添加截断提示并停止递归
 * - 所有路径都经过 guard.resolve() 校验后才进入
 *
 * @param config 运行时配置（用于 blockedGlobs）
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param options 树展示选项
 */
export async function repoTree(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: TreeOptions): Promise<TreeResult> {
  const target = guard.resolve(workspace, options.path ?? ".");
  const stat = await fsp.stat(target.absPath);
  if (!stat.isDirectory()) {
    throw new CodexProError(`Not a directory: ${target.relPath}`);
  }

  const lines: string[] = [target.relPath === "." ? "." : `${target.relPath}/`];
  let entries = 0;
  let truncated = false;

  async function walk(absDir: string, relDir: string, depth: number, prefix: string): Promise<void> {
    if (depth >= options.maxDepth || truncated) return;
    let dirents = await fsp.readdir(absDir, { withFileTypes: true });
    dirents = dirents
      .filter((entry) => options.includeHidden || !isHiddenName(entry.name))
      .filter((entry) => !guard.isBlockedRelativePath(normalizeRelPath(path.join(relDir, entry.name))))
      .sort((a, b) => {
        // 目录优先，同类型按名称字母排序。
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < dirents.length; i += 1) {
      if (entries >= options.maxEntries) {
        truncated = true;
        return;
      }
      const entry = dirents[i];
      const isLast = i === dirents.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      const childAbs = path.join(absDir, entry.name);
      const childRel = normalizeRelPath(path.join(relDir, entry.name));
      const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${prefix}${branch}${displayName}`);
      entries += 1;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1, childPrefix);
      }
      if (truncated) return;
    }
  }

  await walk(target.absPath, target.relPath === "." ? "" : target.relPath, 0, "");
  if (truncated) lines.push(`...[tree truncated after ${entries} entries]`);
  return { text: lines.join("\n"), entries, truncated };
}

/**
 * 递归枚举 workspace 内的文件列表（相对路径数组）。
 *
 * 用于搜索操作（searchOps.ts 的 runNodeSearch）和上下文构建（proContext.ts）。
 * 所有文件都经过以下过滤：
 * - blockedGlobs 检查（PathGuard.isBlockedRelativePath）
 * - 隐藏文件过滤（可选）
 * - glob 模式过滤（可选）
 * - 最大文件数限制
 *
 * 注意：此函数遍历文件系统，在大型仓库中可能较慢。search 工具优先使用
 * ripgrep（如果安装），只有在 ripgrep 不可用时才回退到本函数。
 */
export async function listFiles(
  guard: PathGuard,
  workspace: Workspace,
  options: { root?: string; glob?: string; includeHidden?: boolean; maxFiles: number }
): Promise<string[]> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const stat = await fsp.stat(target.absPath);
  const files: string[] = [];

  async function addFile(absFile: string): Promise<void> {
    const rel = displayPath(absFile, workspace.root);
    if (guard.isBlockedRelativePath(rel)) return;
    if (!options.includeHidden && rel.split("/").some(isHiddenName)) return;
    if (options.glob && !minimatch(rel, options.glob, { dot: true })) return;
    files.push(rel);
  }

  async function walk(absDir: string): Promise<void> {
    if (files.length >= options.maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return;
      const abs = path.join(absDir, entry.name);
      const rel = displayPath(abs, workspace.root);
      if (guard.isBlockedRelativePath(rel)) continue;
      if (!options.includeHidden && rel.split("/").some(isHiddenName)) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) await addFile(abs);
    }
  }

  if (stat.isFile()) await addFile(target.absPath);
  else await walk(target.absPath);
  return files;
}

/**
 * 读取文本文件内容，支持行范围选取和行号展示。
 *
 * 读取前校验流程：
 * 1. guard.resolve()：路径安全校验
 * 2. guard.assertTextFile()：确认是文本文件且未超过大小限制
 * 3. 读取并转换为字符串
 * 4. 按行分割，应用行范围选取
 * 5. 添加行号前缀
 *
 * 返回带行号的文本有两个目的：
 * 1. 帮助模型定位代码，减少上下文混淆
 * 2. 让 edit 工具的 old_text 引用可以精确匹配特定行的内容
 *
 * @param config 运行时配置（maxReadBytes 限制）
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param filePath 工具参数中的文件路径
 * @param options.startLine 起始行（1-indexed，默认 1）
 * @param options.endLine 结束行（1-indexed，默认最后一行）
 * @param options.maxBytes 覆盖默认最大读取字节数
 */
export async function readTextFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { startLine?: number; endLine?: number; maxBytes?: number } = {}
): Promise<ReadFileResult> {
  const resolved = guard.resolve(workspace, filePath);
  const maxBytes = Math.min(options.maxBytes ?? config.maxReadBytes, config.maxReadBytes);
  const hasRange = options.startLine !== undefined || options.endLine !== undefined;
  await guard.assertTextFile(resolved.absPath, hasRange ? textScanByteLimit(config) : maxBytes);
  const buffer = await fsp.readFile(resolved.absPath);
  const text = buffer.toString("utf8");
  const allLines = splitLines(text);
  const totalLines = allLines.length;
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const endLine = Math.min(totalLines, Math.floor(options.endLine ?? totalLines));
  if (endLine < startLine) {
    throw new CodexProError(`end_line (${endLine}) must be >= start_line (${startLine}).`);
  }
  const selected = allLines.slice(startLine - 1, endLine);
  const numbered = withLineNumbers(selected, startLine);
  if (hasRange && Buffer.byteLength(numbered, "utf8") > maxBytes) {
    throw new CodexProError(`Selected line range is too large. Limit: ${maxBytes} bytes.`);
  }
  const truncated = startLine > 1 || endLine < totalLines;
  return {
    path: resolved.relPath,
    text: numbered,
    startLine,
    endLine,
    totalLines,
    bytes: buffer.byteLength,
    sha256: sha256(text),
    truncated
  };
}

/**
 * 写入或覆盖文件内容。
 *
 * 写入前校验：
 * 1. guard.resolve(forWrite: true)：路径安全校验，含父目录符号链接检查
 * 2. 内容大小不超过 maxWriteBytes
 * 3. hasSecretValue()：拒绝含有疑似真实密钥的写入（防止意外提交密钥）
 *    → 如果需要在 handoff 文件中引用密钥，应使用 [REDACTED_SECRET] 占位符
 * 4. 检查目标文件是否已存在（保护 overwrite=false 场景）
 * 5. 如需创建父目录，在 createDirs=true 时自动创建
 *
 * 写入后返回 diff，供 show_changes 工具使用。
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param filePath 目标文件路径（相对于 workspace root）
 * @param content 要写入的文本内容
 * @param options.createDirs 是否自动创建父目录（默认 false）
 * @param options.overwrite 若为 false 且文件已存在则报错（默认允许覆盖）
 */
export async function writeTextFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  content: string,
  options: { createDirs?: boolean; overwrite?: boolean } = {}
): Promise<{ path: string; bytes: number; sha256: string; existed: boolean; diff: DiffResult }> {
  const resolved = guard.resolve(workspace, filePath, { forWrite: true });
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > config.maxWriteBytes) {
    throw new CodexProError(`Write content is too large (${contentBytes} bytes). Limit: ${config.maxWriteBytes} bytes.`);
  }
  // 密钥检测：防止模型将含真实密钥的内容写入 handoff 文件或计划文件，
  // 避免密钥通过 AI Bridge 文件泄露到对话历史中。
  if (hasSecretValue(content)) {
    throw new CodexProError("Secret-looking content is blocked from write. Use placeholders such as [REDACTED_SECRET] in handoff files.");
  }

  let oldText = "";
  let existed = false;
  try {
    await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
    oldText = await fsp.readFile(resolved.absPath, "utf8");
    existed = true;
  } catch (error) {
    if (error instanceof CodexProError && error.message.startsWith("Not a file")) throw error;
    if (fs.existsSync(resolved.absPath)) throw error;
  }

  if (existed && options.overwrite === false) {
    throw new CodexProError(`File already exists and overwrite=false: ${resolved.relPath}`);
  }
  if (options.createDirs) {
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  }

  const diff = makeUnifiedDiff(oldText, content, resolved.relPath);
  await fsp.writeFile(resolved.absPath, content, "utf8");
  return { path: resolved.relPath, bytes: contentBytes, sha256: sha256(content), existed, diff };
}

/**
 * 对已有文件执行精确文本替换（edit 操作）。
 *
 * 精确替换的设计原理：
 * 模型提供的 old_text 必须与文件中的实际内容完全一致，包括空格和换行。
 * 匹配次数有严格语义：
 *
 * ```
 * old_text 在文件中的匹配次数
 *   ├─ 0 次 → 文件已被修改，old_text 不再准确，拒绝操作
 *   ├─ 1 次 → 安全替换（默认行为）
 *   └─ 多次 → 目标不唯一，要求提供更精确的 old_text 或设置 replace_all=true
 * ```
 *
 * 这个设计防止了两类问题：
 * 1. 文件已被其他工具修改时的"盲目写入"（0 次匹配保护）
 * 2. 模型错误地替换了多处相同文本（多次匹配保护）
 *
 * 写入前同样检查 hasSecretValue 和大小限制。
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param filePath 要编辑的文件路径
 * @param oldText 要替换的精确文本内容
 * @param newText 替换后的新文本内容
 * @param options.replaceAll 是否替换所有匹配项（默认 false，仅允许单一匹配）
 * @param options.expectedReplacements 期望的替换次数（不符合时报错）
 */
export async function editTextFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; expectedReplacements?: number } = {}
): Promise<{ path: string; replacements: number; bytes: number; sha256: string; diff: DiffResult }> {
  if (!oldText) throw new CodexProError("old_text must not be empty.");
  const resolved = guard.resolve(workspace, filePath, { forWrite: true });
  await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
  const before = await fsp.readFile(resolved.absPath, "utf8");
  const occurrences = before.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new CodexProError(`old_text was not found in ${resolved.relPath}. Read the file and retry with an exact snippet.`);
  }

  let replacements: number;
  let after: string;
  if (options.replaceAll) {
    after = before.split(oldText).join(newText);
    replacements = occurrences;
  } else {
    if (occurrences !== 1) {
      throw new CodexProError(`old_text matched ${occurrences} times. Provide a more specific old_text or set replace_all=true.`);
    }
    after = before.replace(oldText, newText);
    replacements = 1;
  }

  if (typeof options.expectedReplacements === "number" && replacements !== options.expectedReplacements) {
    throw new CodexProError(`Expected ${options.expectedReplacements} replacements but would perform ${replacements}.`);
  }

  const afterBytes = Buffer.byteLength(after, "utf8");
  if (afterBytes > config.maxWriteBytes) {
    throw new CodexProError(`Edited file would be too large (${afterBytes} bytes). Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(after)) {
    throw new CodexProError("Secret-looking content is blocked from edit. Use placeholders such as [REDACTED_SECRET] in handoff files.");
  }

  const diff = makeUnifiedDiff(before, after, resolved.relPath);
  await fsp.writeFile(resolved.absPath, after, "utf8");
  return { path: resolved.relPath, replacements, bytes: afterBytes, sha256: sha256(after), diff };
}

/**
 * 确保 AI Bridge 上下文目录和标准文件存在（首次时创建）。
 *
 * AI Bridge 目录（默认 .ai-bridge/）是 ChatGPT 与本地 Coding Agent
 * 之间的协作状态共享区域。其中的文件有明确分工：
 *
 * | 文件 | 用途 |
 * |------|------|
 * | current-plan.md | ChatGPT 生成的计划（供 Agent 执行） |
 * | agent-status.md | Agent 的执行状态、触碰的文件、测试结果 |
 * | implementation-diff.patch | Agent 完成后的 review diff |
 * | codex-status.md | 兼容旧版 Codex 的状态文件 |
 * | decisions.md | 架构决策（应保持稳定） |
 * | open-questions.md | 未解决的问题 |
 * | execution-log.jsonl | Agent 执行事件的追加日志 |
 * | session-log.jsonl | 会话事件的追加日志（兼容旧版） |
 *
 * 此函数只创建不存在的文件，不覆盖已有内容（幂等操作）。
 *
 * @returns 本次新创建的文件路径列表（若所有文件已存在则返回 []）
 */
export async function ensureAiBridge(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<string[]> {
  const files: Record<string, string> = {
    "README.md": `# AI Bridge\n\nShared planning context for ChatGPT, other planning models, Codex, OpenCode, Pi, or another local implementation agent.\n\n- current-plan.md: plan produced by ChatGPT or another planning model for the implementation agent.\n- agent-status.md: generic implementation notes, touched files, test results, blockers, and review notes.\n- implementation-diff.patch: final review diff from the implementation agent when practical.\n- codex-status.md: legacy Codex-specific status file, kept for existing workflows.\n- decisions.md: architectural decisions that should remain stable.\n- open-questions.md: unresolved questions.\n- execution-log.jsonl: append-only generic agent handoff and execution events.\n- handoff-run-state.json: machine-readable run lifecycle (running/completed/failed/timed_out) written by execute-handoff/watch-handoff/loop-handoff and polled by the read-only wait_for_handoff tool.\n- session-log.jsonl: append-only legacy session events.\n`,
    "current-plan.md": "# Current Plan\n\nNo plan written yet.\n",
    "agent-status.md": "# Agent Status\n\nNo implementation agent status written yet.\n",
    "implementation-diff.patch": "",
    "codex-status.md": "# Codex Status\n\nNo Codex status written yet.\n",
    "decisions.md": "# Decisions\n\n",
    "open-questions.md": "# Open Questions\n\n",
    "execution-log.jsonl": "",
    "session-log.jsonl": ""
  };
  const created: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const rel = `${config.contextDir}/${name}`;
    const resolved = guard.resolve(workspace, rel, { forWrite: true });
    if (!fs.existsSync(resolved.absPath)) {
      await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fsp.writeFile(resolved.absPath, content, "utf8");
      created.push(rel);
    }
  }
  return created;
}
