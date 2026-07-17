/**
 * 工作区操作模块：Workspace 摘要、Codex 上下文与 AI Bridge 上下文读取。
 *
 * 本文件处理的核心问题：如何为 Coding Agent（Codex、OpenCode、Pi 等）
 * 准备"经过筛选的工作区上下文"？
 *
 * 直接把整个仓库塞给模型是不可行的：
 * - 仓库可能有数千个文件，超出模型的 context window
 * - 无关文件（dist、node_modules）增加 token 消耗而无实际价值
 * - 敏感文件（.env、私钥）不应出现在模型上下文中
 *
 * 本模块的解决方案：
 * - workspaceSummary：生成精简的"工作区地图"（tree + git status + skills）
 * - readCodexContext：为特定目标路径聚合 AGENTS.md 指令和 AI Bridge 状态
 * - readAiBridgeContext：读取 .ai-bridge/ 下的协作状态文件
 * - discoverSkills：发现可用的 Skill 文件列表
 *
 * 上游调用者：src/server.ts（workspace_summary、codex_context、ai_bridge_context 工具）
 * 下游依赖：src/fsOps.ts、src/gitOps.ts、src/capabilitiesOps.ts
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { readTextFile, repoTree, ensureAiBridge } from "./fsOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { discoverSkillInventory } from "./capabilitiesOps.js";
import type { SkillInventoryItem } from "./capabilitiesOps.js";

/**
 * workspaceSummary 的返回结果接口。
 *
 * 包含了供模型快速了解工作区状态的所有关键信息：
 * - 工作区 ID 和根目录路径
 * - AGENTS.md 是否已加载（Agent 操作前应先读取）
 * - Skill 列表和统计（工作区/用户/插件来源）
 * - 目录树文本（可选）
 * - Git 状态
 */
export interface WorkspaceSummary {
  text: string;
  workspaceId: string;
  root: string;
  agentsLoaded: boolean;
  agentsPath?: string;
  skills: string[];
  skillInventory: SkillInventoryItem[];
  skillCounts: Record<string, number>;
  tree?: string;
  gitStatus: string;
}

/**
 * readCodexContext 的返回结果接口。
 *
 * 聚合了 Coding Agent 执行任务前需要了解的所有上下文：
 * - 工作区 ID 和根目录
 * - 当前操作的目标路径
 * - 与目标路径相关的 AGENTS.md 指令文件列表
 * - AI Bridge 协作状态文件列表
 * - Git 状态和 diff（可选）
 */
export interface CodexContext {
  text: string;
  workspaceId: string;
  root: string;
  targetPath: string;
  agentsFiles: string[];
  aiContextFiles: string[];
  gitStatus?: string;
  gitDiff?: string;
}

/** 过滤掉空字符串并去重。 */
function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 安全地读取目录内容，出错时返回空数组。
 *
 * 用于发现 AGENTS.md 和 Skill 文件：目录可能不存在（如尚未创建 .codex/skills/），
 * 静默返回空数组比抛出异常更适合"发现"场景。
 */
async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 发现 workspace 中可用的 Skill 名称列表。
 *
 * 搜索位置（按优先级）：
 * 1. <workspace>/.codex/skills/（workspace 级 Skill）
 * 2. <workspace>/skills/（通用位置）
 * 3. ~/.codex/skills/（用户级 Skill，需 includeGlobal=true）
 * 4. ~/.chatgpt/skills/（ChatGPT 用户 Skill，需 includeGlobal=true）
 *
 * 返回 Skill 名称列表（目录名或 .md 文件名去扩展名），去重排序。
 * 相比 discoverSkillInventory（返回完整元数据），此函数更轻量，
 * 适合只需要显示 Skill 名称列表的场景。
 */
export async function discoverSkills(workspace: Workspace, options: { includeGlobal?: boolean } = {}): Promise<string[]> {
  const candidateDirs = unique([
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, "skills"),
    ...(options.includeGlobal
      ? [path.join(os.homedir(), ".codex", "skills"), path.join(os.homedir(), ".chatgpt", "skills")]
      : [])
  ]);
  const skills: string[] = [];
  for (const dir of candidateDirs) {
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (entry.isDirectory()) skills.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".md")) skills.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return unique(skills).sort((a, b) => a.localeCompare(b));
}

/**
 * 统计 Skill 按来源（workspace/user/plugin/other）的数量。
 *
 * 为模型提供 Skill 分布概览，让模型了解当前工作区有多少专属 Skill
 * 和多少全局 Skill，有助于决定是否需要 load_skill 加载具体内容。
 */
function skillCounts(skills: Array<{ source?: string }>): Record<string, number> {
  const counts: Record<string, number> = { total: skills.length, workspace: 0, user: 0, plugin: 0, other: 0 };
  for (const skill of skills) {
    const source = skill.source ?? "other";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

/**
 * 在 workspace 根目录查找 AGENTS.md 文件（优先级从高到低）。
 *
 * AGENTS.md 文件是 AI Agent 的行为规范，通常包含：
 * - 项目约定（代码风格、测试要求）
 * - 文件组织结构说明
 * - 禁止操作清单
 * - 模型应遵循的工作流步骤
 *
 * @returns 找到的第一个 AGENTS.md 相对路径，未找到时返回 undefined
 */
async function findAgentsFile(workspace: Workspace): Promise<string | undefined> {
  const [first] = await findAgentsFilesInDir(workspace, ".");
  return first;
}

/**
 * 生成从 workspace 根到目标路径的所有祖先目录列表。
 *
 * 用于实现"AGENTS.md 链式加载"：从根目录到目标路径的每个目录都
 * 可能有自己的 AGENTS.md，所有相关 AGENTS.md 会被依次读取并合并。
 *
 * 例如，目标路径 "src/components/Button.tsx" 会生成：
 * ["", "src", "src/components"]（不包含文件名本身，因为它是文件而非目录）
 */
function candidateAgentDirs(targetPath: string): string[] {
  const normalized = targetPath.split(path.sep).join("/").replace(/^\.\//, "");
  const parts = normalized && normalized !== "." ? normalized.split("/").filter(Boolean) : [];
  const dirs = [""];
  // 如果最后一个部分包含 "."（即文件名），则排除它（只保留目录部分）。
  const directoryParts = parts.length > 0 && parts.at(-1)?.includes(".") ? parts.slice(0, -1) : parts;
  for (let i = 0; i < directoryParts.length; i += 1) {
    dirs.push(directoryParts.slice(0, i + 1).join("/"));
  }
  return [...new Set(dirs)];
}

/**
 * 在指定目录中查找 AGENTS.md 文件（按优先级顺序）。
 *
 * 查找优先级：
 * 1. AGENTS.override.md（最高优先级，完全覆盖）
 * 2. AGENTS.md（标准文件名）
 * 3. agents.md（小写变体）
 * 4. .agents.md（隐藏文件变体）
 *
 * 使用 realpath 去重，防止大小写不敏感文件系统（macOS APFS 等）返回重复文件。
 */
async function findAgentsFilesInDir(workspace: Workspace, dir: string): Promise<string[]> {
  const names = ["AGENTS.override.md", "AGENTS.md", "agents.md", ".agents.md"];
  const absDir = path.join(workspace.root, dir);
  const entries = await safeReaddir(absDir);
  const files = entries.filter((entry) => entry.isFile());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const entry =
      files.find((item) => item.name === name) ??
      files.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!entry) continue;
    const rel = dir && dir !== "." ? `${dir}/${entry.name}` : entry.name;
    const real = fs.realpathSync(path.join(workspace.root, rel)).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(rel);
  }
  return out;
}

/**
 * 读取目标路径对应的所有 AGENTS.md 文件并合并为单一文本块。
 *
 * 对于特定的目标文件，会从 workspace 根到该文件所在目录逐级读取 AGENTS.md，
 * 形成"指令链"。这样既有全局的项目约定，又有针对特定子目录的局部指令。
 *
 * 每个 AGENTS.md 文件内容以 "--- <path> ---" 分隔，便于模型识别来源。
 * 读取失败的文件记录为 "[unreadable: <error>]" 而非中断，保证鲁棒性。
 *
 * @param config 运行时配置（maxReadBytes 限制单个文件大小）
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param targetPath 当前操作的目标路径
 * @param maxBytes 单个文件的最大读取字节数
 */
async function readAgentsChain(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  targetPath: string,
  maxBytes: number
): Promise<{ text: string; files: string[] }> {
  const chunks: string[] = [];
  const files: string[] = [];
  const seenRealPaths = new Set<string>();
  const candidates = (
    await Promise.all(candidateAgentDirs(targetPath).map((dir) => findAgentsFilesInDir(workspace, dir || ".")))
  ).flat();
  for (const rel of candidates) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (!fs.existsSync(resolved.absPath)) continue;
      const real = fs.realpathSync(resolved.absPath).toLowerCase();
      if (seenRealPaths.has(real)) continue;
      seenRealPaths.add(real);
      const agents = await readTextFile(config, guard, workspace, rel, { maxBytes });
      chunks.push(`--- ${rel} ---\n${agents.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
      files.push(rel);
    }
  }
  return {
    text: chunks.length ? chunks.join("\n\n") : "No AGENTS.md-style instruction files found for this target path.",
    files
  };
}

/**
 * 生成 workspace 的综合摘要（workspace_summary 工具的实现）。
 *
 * 摘要包含的信息按重要性排列：
 * 1. 工作区基本信息（ID、root、配置模式）
 * 2. AGENTS.md 状态（是否存在，路径）
 * 3. Skill 统计（可选，include_skills=true 时）
 * 4. Git 状态和最近提交
 * 5. 目录树（可选，include_tree=true 时）
 *
 * 为什么不总是包含完整目录树？
 * 树形展示对大型仓库可能很大，在只需要 git 状态或 Skill 信息时
 * 包含完整树会浪费 token 预算。
 *
 * bootstrapContext=true 时会调用 ensureAiBridge 初始化协作目录，
 * 这在首次打开 workspace 时使用，确保协作目录结构存在。
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param options 摘要选项（includeTree、maxDepth、bootstrapContext 等）
 */
export async function workspaceSummary(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { includeTree?: boolean; maxDepth?: number; maxEntries?: number; bootstrapContext?: boolean; includeSkills?: boolean; includeGlobalSkills?: boolean } = {}
): Promise<WorkspaceSummary> {
  if (options.bootstrapContext) {
    await ensureAiBridge(config, guard, workspace);
  }
  const skillInventory = options.includeSkills
    ? await discoverSkillInventory(workspace, { includeGlobal: options.includeGlobalSkills !== false, maxSkills: 120 })
    : [];
  const skills = skillInventory.map((skill) => skill.name);
  const counts = skillCounts(skillInventory);
  const agentsPath = await findAgentsFile(workspace);
  let agentsText = "AGENTS.md: none loaded";
  if (agentsPath) {
    agentsText = `AGENTS.md: ${agentsPath} (read this file before editing or making project decisions).`;
  }

  let treeText: string | undefined;
  if (options.includeTree !== false) {
    const tree = await repoTree(config, guard, workspace, {
      path: ".",
      maxDepth: Math.max(1, Math.min(options.maxDepth ?? 3, 8)),
      includeHidden: false,
      maxEntries: Math.max(1, Math.min(options.maxEntries ?? 500, 3000))
    });
    treeText = tree.text;
  }

  const status = gitStatus(config, workspace);
  const log = gitLog(config, workspace, 5);
  const skillText = options.includeSkills
    ? `Skills: ${counts.total} total (${counts.workspace ?? 0} workspace, ${counts.user ?? 0} user, ${counts.plugin ?? 0} plugin, ${counts.other ?? 0} other).`
    : "Skills: skipped. Pass include_skills=true if skill discovery is needed.";
  const text = `# Workspace\n\nWorkspace: ${workspace.id}\nRoot: ${workspace.root}\nBash mode: ${config.bashMode}\nWrite mode: ${config.writeMode}\nTool mode: ${config.toolMode}\n\n${agentsText}\n${skillText}\n\n## Git status\n\n${status}\n\n## Recent commits\n\n${log}\n${treeText ? `\n## Files\n\n${treeText}` : ""}`;

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    agentsLoaded: Boolean(agentsPath),
    agentsPath,
    skills,
    skillInventory,
    skillCounts: counts,
    tree: treeText,
    gitStatus: status
  };
}

/**
 * 读取 AI Bridge 上下文（ai_bridge_context 工具的实现）。
 *
 * AI Bridge（.ai-bridge/）是 ChatGPT 与本地 Coding Agent 的协作状态共享区域。
 * 此函数读取其中的所有标准文件并合并为文本，让调用方（通常是 Agent 本身）
 * 了解当前的计划、状态、未解决问题和历史执行记录。
 *
 * 读取的文件及其用途：
 * - current-plan.md：ChatGPT 为本次任务生成的执行计划
 * - agent-status.md：Agent 的实现进度、触碰的文件、测试结果、阻碍因素
 * - implementation-diff.patch：Agent 完成后的代码差异（供 ChatGPT review）
 * - codex-status.md：兼容旧版 Codex 的状态文件
 * - decisions.md：需要保持稳定的架构决策
 * - open-questions.md：待解决的问题列表
 * - execution-log.jsonl：执行事件的追加日志（最近的事件）
 *
 * createIfMissing=true 时会先调用 ensureAiBridge 创建目录结构，
 * 适用于需要确保协作目录存在的场景（如 open_workspace 后的首次读取）。
 */
export async function readAiBridgeContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { createIfMissing?: boolean } = {}
): Promise<{ text: string; files: string[] }> {
  if (options.createIfMissing) {
    await ensureAiBridge(config, guard, workspace);
  } else {
    const bridgeDir = guard.resolve(workspace, config.contextDir);
    if (!fs.existsSync(bridgeDir.absPath)) {
      return {
        text: `No ${config.contextDir} handoff context exists yet. Use handoff_to_agent or handoff_to_codex to create it when a plan is ready.`,
        files: []
      };
    }
  }
  const relFiles = [
    `${config.contextDir}/current-plan.md`,
    `${config.contextDir}/agent-status.md`,
    `${config.contextDir}/implementation-diff.patch`,
    `${config.contextDir}/codex-status.md`,
    `${config.contextDir}/decisions.md`,
    `${config.contextDir}/open-questions.md`,
    `${config.contextDir}/execution-log.jsonl`
  ];
  const chunks: string[] = [];
  const files: string[] = [];
  for (const rel of relFiles) {
    try {
      const read = await readTextFile(config, guard, workspace, rel, { maxBytes: 80_000 });
      chunks.push(`--- ${rel} ---\n${read.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return { text: chunks.join("\n\n"), files };
}

/**
 * 读取 Codex Context（codex_context 工具的实现）。
 *
 * Codex Context 是专门为 Coding Agent 准备的"启动包"，聚合了：
 * 1. 工作区基本信息（ID、root、配置模式）
 * 2. 目标路径对应的 AGENTS.md 指令链（从根到目标路径）
 * 3. AI Bridge 当前状态（计划、状态、历史）
 * 4. Git 状态（可选）
 * 5. Git diff（可选，通常比较大）
 *
 * Context 与 MCP Resource 的区别：
 * - MCP Resource 是服务端维护的可订阅资源，需要客户端主动请求。
 * - Codex Context 是工具调用的即时结果，每次调用都重新生成。
 *   这避免了 Resource 订阅的复杂性，同时保证数据实时性。
 *
 * 为什么专门为 Agent 准备上下文，而不让 Agent 自己用工具读取？
 * - 减少 Agent 启动时的工具调用轮次（一次 codex_context 替代多个独立读取）
 * - 确保 AGENTS.md 链式加载（Agent 可能不知道要向上查找 AGENTS.md）
 * - 限制注入模型的信息量（只提供相关文件，避免塞满 context window）
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param options.targetPath 当前操作的目标路径（用于 AGENTS.md 链查找）
 * @param options.includeAiBridge 是否包含 AI Bridge 状态（默认 true）
 * @param options.includeGit 是否包含 Git 状态（默认 true）
 * @param options.includeDiff 是否包含 Git diff（默认 false，通常较大）
 * @param options.maxAgentBytes AGENTS.md 文件的最大读取字节数
 */
export async function readCodexContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    targetPath?: string;
    includeAiBridge?: boolean;
    includeGit?: boolean;
    includeDiff?: boolean;
    maxAgentBytes?: number;
  } = {}
): Promise<CodexContext> {
  const targetPath = options.targetPath ?? ".";
  // 先通过 PathGuard 校验目标路径的合法性，确保不会逃出 workspace。
  guard.resolve(workspace, targetPath);
  const agents = await readAgentsChain(config, guard, workspace, targetPath, Math.min(options.maxAgentBytes ?? 60_000, config.maxReadBytes));
  const ai = options.includeAiBridge === false
    ? { text: "Skipped by request.", files: [] }
    : await readAiBridgeContext(config, guard, workspace);
  const status = options.includeGit === false ? undefined : gitStatus(config, workspace);
  const diff = options.includeDiff ? gitDiff(config, guard, workspace) : undefined;

  const text = [
    "# Codex Context",
    "",
    `Workspace: ${workspace.id}`,
    `Root: ${workspace.root}`,
    `Target path: ${targetPath}`,
    `Bash mode: ${config.bashMode}`,
    `Write mode: ${config.writeMode}`,
    `Tool mode: ${config.toolMode}`,
    "",
    "## AGENTS Instructions",
    "",
    agents.text,
    "",
    "## AI Bridge Context",
    "",
    ai.text,
    ...(status !== undefined ? ["", "## Git Status", "", status] : []),
    ...(diff !== undefined ? ["", "## Git Diff", "", diff] : [])
  ].join("\n");

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    targetPath,
    agentsFiles: agents.files,
    aiContextFiles: ai.files,
    gitStatus: status,
    gitDiff: diff
  };
}
