/**
 * 代码搜索操作模块：在 workspace 中搜索文本内容。
 *
 * 本模块实现了两种搜索策略：
 * 1. ripgrep（rg）优先：如果系统已安装 ripgrep，使用它执行搜索。
 *    ripgrep 性能极高，原生支持 glob 过滤和 .gitignore 规则。
 * 2. Node.js 回退：ripgrep 不可用时，通过枚举文件并逐行搜索实现。
 *    性能较低，但无额外依赖，确保在任何环境都能运行。
 *
 * 为什么有专门的搜索工具，而不是用 Bash 执行 grep/rg？
 * - 搜索工具受 PathGuard 和 blockedGlobs 保护，不会扫描 .env、.git 等敏感目录。
 * - 搜索结果经过 redactSensitiveText 脱敏，防止密钥通过搜索结果泄露。
 * - 搜索范围由 workspace 限制，不会意外扫描整个磁盘。
 * - Bash 模式为 "safe" 时，grep/rg 等文件读取命令被阻断，搜索工具提供了
 *   安全的替代方案。
 *
 * 上游调用者：src/server.ts（search 工具 handler）
 * 下游依赖：node:child_process（spawn rg）、src/fsOps.ts（listFiles 回退）
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { listFiles, textScanByteLimit } from "./fsOps.js";
import { redactSensitiveText } from "./redact.js";
import { searchWorkspaceStructured, type AnalysisSearchIntent, type StructuredSearchResult } from "./analysis/index.js";

/** searchWorkspace 的输入参数。 */
export interface SearchOptions {
  /** 搜索关键字或正则表达式。 */
  query: string;
  /** 是否将 query 作为正则表达式处理（false = 字面字符串匹配）。 */
  regex: boolean;
  /** 搜索的根目录（相对于 workspace root），默认为 "."（全工作区）。 */
  root?: string;
  /** 限定搜索的文件 glob 模式（如 "*.ts"）。 */
  glob?: string;
  /** 是否搜索隐藏文件（以 . 开头的文件）。 */
  includeHidden: boolean;
  /** 最大返回结果数。 */
  maxResults: number;
  intent?: AnalysisSearchIntent;
  symbol?: string;
  includeTests?: boolean;
}

/** searchWorkspace 的返回结果。 */
export interface SearchResult {
  /** 格式化的搜索结果文本（path:line: content 格式）。 */
  text: string;
  /** 结构化的匹配结果数组。 */
  matches: Array<{ path: string; line: number; text: string }>;
  /** 是否因超过 maxResults 或输出限制而被截断。 */
  truncated: boolean;
  /** 实际使用的搜索引擎（"ripgrep" 或 "node"）。 */
  used: "ripgrep" | "node";
  analysis?: StructuredSearchResult;
}

/**
 * 检测系统中指定命令是否可用。
 *
 * 使用 "command -v" 而非 "which"，前者是 POSIX 标准，在 bash/sh 中更通用。
 * 子进程在 /bin/sh 中以 login shell 方式运行，确保能找到通过 homebrew、nvm 等
 * 工具安装的命令。
 */
function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn("where", [command], { stdio: "ignore", shell: false })
      : spawn("/bin/sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * 截断过长的行，防止搜索结果中的单行超过 max 字符。
 *
 * 过长行通常是压缩的 JSON 或 minified 代码，对模型没有价值，
 * 截断可以减少 token 消耗并保持结果可读性。
 */
function truncateLine(line: string, max = 400): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

/**
 * 使用 ripgrep 执行搜索。
 *
 * ripgrep 的调用参数说明：
 * - --line-number：输出行号
 * - --no-heading：每行独立输出（方便解析）
 * - --color=never：禁用颜色转义码
 * - --max-columns 500：单行最大字符数（超过则截断）
 * - --max-count 50：每文件最多匹配 50 行
 * - --fixed-strings：字面字符串模式（非正则时使用）
 * - --hidden：搜索隐藏文件（当 includeHidden=true 时）
 * - -g !.*：排除隐藏文件（当 includeHidden=false 时）
 * - blockedGlobs：追加为 -g !<glob> 排除规则
 *
 * 结果后处理：
 * - 解析每行 "path:line:text" 格式
 * - 过滤掉逃出 workspace 的路径（理论上不应出现，但做双重保护）
 * - 过滤掉命中 blockedGlobs 的结果（rg 的 -g 过滤可能存在边界情况）
 * - 对匹配文本脱敏
 */
async function runRipgrep(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const args = ["--json", "--line-number", "--with-filename", "--no-heading", "--color=never", "--max-columns", "500", "--max-count", "50", "--max-filesize", String(textScanByteLimit(config))];
  if (!options.regex) args.push("--fixed-strings");
  if (options.includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  // Pass the query via -e so patterns beginning with "-" (e.g. "->", "--flag")
  // are treated as the search term instead of ripgrep options.
  args.push("-e", options.query, "--", target.absPath);

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      // 输出超限时终止进程，防止大型仓库的搜索消耗过多内存。
      if (stdout.length > config.maxOutputBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // ripgrep 退出码：0=有匹配，1=无匹配，>1=错误。
      if (code && code > 1) {
        reject(new CodexProError(stderr.trim() || `ripgrep failed with exit code ${code}`));
        return;
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const lines = stdout.split("\n").filter(Boolean);
      let visibleMatches = 0;
      for (const line of lines) {
        const value = JSON.parse(line);
        if (value.type !== "match") continue;
        const absPath = path.resolve(value.data?.path?.text ?? "");
        const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
        // 双重保护：过滤掉意外逃出 workspace 或命中 blockedGlobs 的结果。
        if (rel.startsWith("..")) continue;
        if (guard.isBlockedRelativePath(rel)) continue;
        visibleMatches += 1;
        if (matches.length >= options.maxResults) continue;
        const lineText = String(value.data?.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({ path: rel || ".", line: Number(value.data?.line_number ?? 0), text: redactSensitiveText(truncateLine(lineText)) });
      }
      const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
      resolve({ text, matches, truncated: visibleMatches > matches.length || stdout.length > config.maxOutputBytes, used: "ripgrep" });
    });
  });
}

/**
 * 使用 Node.js 原生文件读取执行搜索（ripgrep 不可用时的回退）。
 *
 * 工作流程：
 * 1. 通过 listFiles 枚举所有符合条件的文件
 * 2. 跳过过大文件（超过 maxReadBytes）和二进制文件（含 null 字节）
 * 3. 对每个文件逐行搜索
 * 4. 脱敏匹配到的文本后加入结果列表
 *
 * 与 ripgrep 相比的缺点：性能较低（纯 JS 实现）、不支持复杂正则优化。
 * 但在没有 ripgrep 的环境中提供了可靠的回退。
 */
async function runNodeSearch(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let visibleMatches = 0;
  const scanBytes = textScanByteLimit(config);
  const matcher = options.regex ? new RegExp(options.query) : undefined;
  for (const rel of files) {
    if (visibleMatches > options.maxResults) break;
    const resolved = guard.resolve(workspace, rel);
    try {
      const stat = await fsp.stat(resolved.absPath);
      if (stat.size > scanBytes) continue;
      const buffer = await fsp.readFile(resolved.absPath);
      // 二进制文件检测：含 null 字节的文件跳过，避免搜索二进制内容。
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const hit = matcher ? matcher.test(line) : line.includes(options.query);
        if (hit) {
          visibleMatches += 1;
          if (matches.length < options.maxResults) {
            matches.push({ path: rel, line: i + 1, text: redactSensitiveText(truncateLine(line)) });
          }
          if (visibleMatches > options.maxResults) break;
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
  return { text, matches, truncated: visibleMatches > matches.length, used: "node" };
}

/**
 * 在 workspace 中执行文本搜索（search 工具的实现）。
 *
 * 自动检测 ripgrep 可用性并选择最优搜索引擎。正则模式下提前校验
 * 正则语法，在回退到 Node 搜索前给出清晰的错误提示。
 *
 * 参数验证：
 * - query 不能为空
 * - maxResults 被限制在配置的 maxSearchResults 范围内
 * - 正则表达式提前编译验证语法（避免在子进程中失败时难以调试）
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param rawOptions 来自工具调用的原始参数（部分字段可能缺失）
 */
export async function searchWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace, rawOptions: Partial<SearchOptions>): Promise<SearchResult> {
  const query = rawOptions.symbol?.toString() || rawOptions.query?.toString() || "";
  if (!query) throw new CodexProError("query is required.");
  const options: SearchOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults)),
    intent: rawOptions.intent,
    symbol: rawOptions.symbol,
    includeTests: rawOptions.includeTests
  };
  let lexical: SearchResult;
  if (await commandExists("rg")) {
    lexical = await runRipgrep(config, guard, workspace, options);
  } else if (options.regex) {
    throw new CodexProError("regex search requires ripgrep. Install rg or retry with regex=false.");
  } else {
    lexical = await runNodeSearch(config, guard, workspace, options);
  }
  const structuredRequested = rawOptions.intent !== undefined || rawOptions.symbol !== undefined || rawOptions.includeTests !== undefined;
  if (!structuredRequested) return lexical;
  if (!config.analysisEnabled) {
    lexical.analysis = {
      schemaVersion: 1,
      query,
      intent: rawOptions.intent && rawOptions.intent !== "auto" ? rawOptions.intent : "text",
      groups: { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] },
      matches: [],
      coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0, relationshipCount: 0, truncated: true, warnings: ["Repository analysis is disabled by configuration."] },
      warnings: ["Repository analysis is disabled by configuration."],
      cache: { hit: false, key: "disabled" }
    };
    return lexical;
  }
  try {
    lexical.analysis = await searchWorkspaceStructured(config, guard, workspace, {
      query,
      intent: rawOptions.intent ?? "auto",
      includeTests: Boolean(rawOptions.includeTests),
      regex: Boolean(rawOptions.regex),
      root: options.root,
      maxResults: options.maxResults
    });
  } catch (error) {
    lexical.analysis = {
      schemaVersion: 1,
      query,
      intent: rawOptions.intent && rawOptions.intent !== "auto" ? rawOptions.intent : "text",
      groups: { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] },
      matches: [],
      coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0, relationshipCount: 0, truncated: true, warnings: [] },
      warnings: [`Repository analysis unavailable: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`],
      cache: { hit: false, key: "unavailable" }
    };
  }
  return lexical;
}
