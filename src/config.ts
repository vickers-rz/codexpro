/**
 * 配置加载与集中管理模块。
 *
 * 本文件负责从命令行参数和环境变量中读取 CodexPro 的所有运行时配置，
 * 构建为强类型的 CodexProConfig 对象，供全局所有模块使用。
 *
 * 集中管理配置的价值：
 * - 避免各模块直接读取 process.env，使配置来源可追踪。
 * - 统一默认值、类型转换、合法性校验，减少各处的重复逻辑。
 * - 便于测试时传入 mock 配置，隔离副作用。
 *
 * 配置加载优先级（从高到低）：
 * 1. 命令行参数（--root、--bash、--port 等）
 * 2. 环境变量（CODEXPRO_* 前缀）
 * 3. 兼容旧版环境变量（CODEBASE_BRIDGE_* 前缀）
 * 4. 内置默认值
 *
 * 安全边界说明：
 * - allowedRoots 决定了哪些目录可以作为 Workspace root。
 *   不在此列表中的路径即使通过网络请求也无法被 open_workspace 接受。
 * - requireHttpToken 在非 loopback 地址监听时自动启用，防止局域网未授权访问。
 * - blockedGlobs 提供默认的敏感文件保护，用户可追加但不可替换默认值。
 *
 * 外部网络暴露风险：
 * 当 host 非 loopback（如 0.0.0.0）时，CodexPro 将监听网络接口，
 * 此时 requireHttpToken 会被自动强制为 true，要求每个请求携带 Bearer Token。
 * 即便如此，仍强烈建议仅通过受信任的隧道（Cloudflare Tunnel）对外暴露，
 * 而不是直接开放公网端口。
 *
 * 上游调用者：src/stdio.ts（stdio 启动入口）、src/http.ts（HTTP 启动入口）
 * 下游依赖：node:fs、node:os、node:path
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ANALYSIS_LIMITS, type AnalysisLimits } from "./analysis/types.js";

/**
 * Bash 工具的执行模式：
 * - "off"：完全禁用 bash 工具，适合只读场景。
 * - "safe"：只允许执行 allowlist 中的验证命令（build、test、lint 等），拒绝破坏性操作。
 * - "full"：允许执行任意命令，仅适用于可完全信任的本地仓库。
 */
export type BashMode = "off" | "safe" | "full";

/**
 * Bash 输出的详细程度：
 * - "compact"：仅返回摘要（退出码、行数），原始 stdout/stderr 在 structuredContent 中。
 * - "full"：在文本结果中也包含完整 stdout/stderr，适合调试时使用。
 */
export type BashTranscriptMode = "compact" | "full";

/**
 * Codex 历史会话访问模式：
 * - "off"：不提供任何会话相关工具。
 * - "metadata"：只能列出会话（标题、时间、项目路径），不能读取会话内容。
 * - "read"：可以读取完整会话 transcript（注意：会话内容可能含有敏感信息）。
 */
export type CodexSessionsMode = "off" | "metadata" | "read";

/**
 * 文件写入权限模式：
 * - "off"：禁止所有写入操作（write/edit 工具不可用）。
 * - "handoff"：只能写入 .ai-bridge/ 上下文目录，不能修改源代码。
 * - "workspace"：可以写入 workspace 内任何非阻断路径的文件（完整 AI 编程模式）。
 */
export type WriteMode = "off" | "handoff" | "workspace";

/**
 * 工具集模式，控制向 MCP 客户端暴露的工具数量：
 * - "minimal"：只暴露最基础的工具集，适合资源受限或安全优先场景。
 * - "standard"：标准工具集，包括 tree、search、handoff 等常用工具（默认）。
 * - "full"：暴露所有工具，包括 workspace_snapshot、git_diff、codex_sessions 等高级工具。
 */
export type ToolMode = "minimal" | "standard" | "full";

/**
 * CodexPro 完整运行时配置接口。
 *
 * 本接口的所有字段由 loadConfig() 一次性填充，运行期间不可变。
 * 各模块通过函数参数传递 config 而不是全局变量，便于测试和多实例场景。
 */
export interface CodexProConfig {
  /** 默认工作区根目录（真实路径，已 realpath 解析） */
  defaultRoot: string;
  /** 允许打开的所有工作区根目录（真实路径列表） */
  allowedRoots: string[];
  /** HTTP 服务监听地址（如 127.0.0.1 或 0.0.0.0） */
  host: string;
  /** HTTP 服务监听端口 */
  port: number;
  /** Tool Card Widget 允许的域名来源（用于 CSP） */
  widgetDomain: string;
  /** HTTP Bearer Token（来自 CODEXPRO_HTTP_TOKEN 环境变量） */
  authToken?: string;
  /** 是否要求 HTTP 请求携带 Bearer Token */
  requireHttpToken: boolean;
  /** Bash 工具执行模式 */
  bashMode: BashMode;
  /** Bash 输出详细程度 */
  bashTranscript: BashTranscriptMode;
  /** Bash 会话 ID（用于会话隔离校验） */
  bashSessionId?: string;
  /** 是否要求 bash 工具调用必须携带 session_id */
  requireBashSession: boolean;
  /** Codex 会话历史访问模式 */
  codexSessions: CodexSessionsMode;
  /** Codex 会话文件存放目录（默认 ~/.codex） */
  codexDir: string;
  /** 文件写入权限模式 */
  writeMode: WriteMode;
  /** 工具集模式 */
  toolMode: ToolMode;
  /** 是否将完整的父进程环境变量传递给子进程 */
  inheritEnv: boolean;
  /** 单次文件读取的最大字节数 */
  maxReadBytes: number;
  /** 单次文件写入的最大字节数 */
  maxWriteBytes: number;
  /** 单次命令输出的最大字节数 */
  maxOutputBytes: number;
  /** 单次搜索的最大结果数 */
  maxSearchResults: number;
  /** HTTP 会话的最大并发数 */
  maxHttpSessions: number;
  /** HTTP 会话的 TTL（毫秒） */
  httpSessionTtlMs: number;
  /** 阻断访问的 glob 模式列表（.git、.env、*.key 等） */
  blockedGlobs: string[];
  /** AI Bridge 上下文目录名（默认 .ai-bridge） */
  contextDir: string;
  toolCards: boolean;
  connectionTest: boolean;
  analysisEnabled: boolean;
  analysisLimits: AnalysisLimits;
}

/**
 * 默认的敏感路径阻断规则。
 *
 * 这些规则防止模型意外读取或写入以下类型的文件：
 * - Git 内部状态（.git/**）
 * - 依赖包目录（node_modules/**）
 * - 环境变量文件（.env、.env.*）
 * - 私钥和证书（*.pem、*.key、id_rsa、id_ed25519、.ssh/**）
 * - 构建产物（dist/**、build/**、.next/**、coverage/**、.cache/**）
 *
 * 注意：用户可通过 CODEXPRO_BLOCKED_GLOBS 追加额外规则，但不能覆盖这里的默认规则。
 * 这是一个"只能添加"的安全策略设计，确保最低安全基线始终生效。
 */
const DEFAULT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env/**",
  ".env.*",
  ".env.*/**",
  "**/.env",
  "**/.env/**",
  "**/.env.*",
  "**/.env.*/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**"
];

/**
 * 解析 --key value 和 --key=value 形式的命令行参数。
 *
 * --allow-root 是可重复参数，每次出现都追加到数组；其他参数只取最后一个值。
 * 布尔标志（无值）会被设为 true。
 */
function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eqIndex >= 0) {
      key = withoutPrefix.slice(0, eqIndex);
      value = withoutPrefix.slice(eqIndex + 1);
    } else {
      key = withoutPrefix;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === "allow-root") {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else if (prev) out[key] = [String(prev), String(value)];
      else out[key] = [String(value)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 展开路径中的 ~ 为用户主目录。
 *
 * 支持 "~"（等于主目录本身）和 "~/..." 两种形式。
 * 其他形式的路径原样返回。
 */
export function expandHome(input: string): string {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * 将分隔符字符串拆分为非空字符串数组，默认使用 path.delimiter（: 或 ;）。
 */
function splitList(value: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 将 PATH 风格的路径列表（: 或 ; 分隔）拆分为数组。
 */
function splitRoots(value: string | undefined): string[] {
  return splitList(value, path.delimiter);
}

/**
 * 将字符串路径解析为存在的真实目录路径。
 *
 * 展开 ~、解析为绝对路径、确认存在且是目录、最后用 realpathSync 消除符号链接。
 * 用于将配置中的根目录路径转换为规范化的真实路径，确保 allowedRoots 校验
 * 可以正确处理包含符号链接的路径。
 */
function toRealDir(input: string): string {
  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

/**
 * 将字符串解析为有界整数。解析失败或超界时返回 fallback。
 */
function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * 解析 Bash 模式字符串，非法值回退到 "safe"（保守默认）。
 *
 * 默认 "safe" 而非 "off" 是为了保持可用性；"full" 需要显式配置，
 * 防止用户在不了解风险的情况下意外开启无限制命令执行。
 */
function bashModeFrom(value: string | undefined): BashMode {
  if (value === "off" || value === "safe" || value === "full") return value;
  return "safe";
}

/** 解析 Bash transcript 模式字符串，默认 "compact"（减少 token 消耗）。 */
function bashTranscriptFrom(value: string | undefined): BashTranscriptMode {
  if (value === "compact" || value === "full") return value;
  return "compact";
}

/**
 * 解析 Codex 会话模式字符串，默认 "off"（不暴露会话历史）。
 *
 * 接受 "1"/"true"/"yes"/"on" 作为 "metadata" 的别名（向后兼容）。
 * 读取会话内容是敏感操作，需要显式传入 "read" 才能启用。
 */
function codexSessionsFrom(value: string | undefined): CodexSessionsMode {
  if (value === "metadata" || value === "read") return value;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "metadata";
  return "off";
}

/**
 * 解析并校验 Bash 会话 ID 格式。
 *
 * 会话 ID 必须是 1-64 位的字母、数字、点、下划线或连字符，且以字母或数字开头。
 * 此校验防止会话 ID 被用作路径或 shell 注入载体。
 */
function bashSessionIdFrom(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error("CODEXPRO_BASH_SESSION_ID must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.");
  }
  return trimmed;
}

/**
 * 解析写入模式字符串，默认 "workspace"（完整写入权限）。
 *
 * "workspace" 是默认值，因为 CodexPro 的核心使用场景是 AI 辅助编程，
 * 需要能够修改源代码文件。如需只读或限制写入，应显式配置。
 */
function writeModeFrom(value: string | undefined): WriteMode {
  if (value === "off" || value === "handoff" || value === "workspace") return value;
  return "workspace";
}

/** 解析工具模式字符串，默认 "standard"（平衡功能与简洁性）。 */
function toolModeFrom(value: string | undefined): ToolMode {
  if (value === "minimal" || value === "standard" || value === "full") return value;
  return "standard";
}

/**
 * 解析并校验 Widget Domain。
 *
 * Widget Domain 必须是有效的 HTTPS origin URL（无路径、无查询参数）。
 * 此校验确保 Tool Card Widget 的 CSP 配置中不会出现格式错误的域名。
 * 要求 HTTPS 是因为 Tool Card Widget 由 ChatGPT 等安全环境加载，
 * HTTP 域名不被允许。
 */
function widgetDomainFrom(value: string | undefined): string {
  const raw = value?.trim() || "https://rebel0789.github.io";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CODEXPRO_WIDGET_DOMAIN must be a valid origin URL, got: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("CODEXPRO_WIDGET_DOMAIN must use https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("CODEXPRO_WIDGET_DOMAIN must be an origin only, for example https://widgets.example.com.");
  }
  return parsed.origin;
}

function contextDirFrom(value: string | undefined): string {
  const raw = (value?.trim() || ".ai-bridge").replaceAll("\\", "/");
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("CODEXPRO_CONTEXT_DIR must be a workspace-relative hidden directory, for example .ai-bridge.");
  }

  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("CODEXPRO_CONTEXT_DIR must stay inside the workspace.");
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("CODEXPRO_CONTEXT_DIR must be a simple relative directory path.");
  }
  if (!parts[0].startsWith(".")) {
    throw new Error("CODEXPRO_CONTEXT_DIR must start with a hidden directory such as .ai-bridge.");
  }

  const blocked = new Set([".git", ".ssh", ".gnupg", ".cache", "node_modules", "src", "dist", "build", ".next", "coverage"]);
  if (parts.some((part) => blocked.has(part))) {
    throw new Error("CODEXPRO_CONTEXT_DIR cannot point at source, dependency, build, cache, or credential directories.");
  }
  return normalized;
}

/**
 * 将常见真值字符串（1/true/yes/y/on）解析为布尔值。
 *
 * 不区分大小写，非真值字符串返回 fallback（默认 false）。
 */
function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

/**
 * 判断是否是本地回环地址。
 *
 * 只有在回环地址上监听时，才可以在没有 Token 的情况下接受请求。
 * 一旦监听 0.0.0.0 或非回环地址，requireHttpToken 会被强制启用。
 */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * 加载并构建完整的 CodexPro 运行时配置。
 *
 * 读取命令行参数和环境变量，进行校验和类型转换，返回不可变的配置对象。
 * 此函数是应用启动的入口点之一，配置加载失败会直接导致进程退出。
 *
 * allowedRoots 的构建逻辑：
 * - 始终包含 defaultRoot（当前工作区根目录）
 * - 追加 --allow-root 命令行参数指定的额外根目录
 * - 追加 CODEXPRO_ALLOWED_ROOTS 和 CODEBASE_BRIDGE_ALLOWED_ROOTS 环境变量指定的根目录
 * - 如果设置了 CODEXPRO_ALLOW_HOME=1，追加用户主目录（允许访问整个主目录）
 * - 所有路径去重、realpath 规范化
 *
 * requireHttpToken 的自动推断：
 * - 显式设置 CODEXPRO_REQUIRE_HTTP_TOKEN=1 → 强制要求
 * - 显式设置 CODEXPRO_TUNNEL_MODE=1 → 强制要求（隧道模式必须认证）
 * - host 非回环地址且未设置 CODEXPRO_ALLOW_NO_HTTP_TOKEN=1 → 自动启用
 *
 * @param argv 命令行参数数组（默认 process.argv.slice(2)）
 * @returns 完整的 CodexProConfig 对象
 */
export function loadConfig(argv = process.argv.slice(2)): CodexProConfig {
  const args = parseArgs(argv);

  const rootFromArgs = typeof args.root === "string" ? args.root : undefined;
  const root = rootFromArgs ?? process.env.CODEXPRO_ROOT ?? process.env.CODEBASE_BRIDGE_REPO_ROOT ?? process.cwd();
  const defaultRoot = toRealDir(root);

  const allowRootArgs = Array.isArray(args["allow-root"])
    ? args["allow-root"]
    : typeof args["allow-root"] === "string"
      ? [args["allow-root"]]
      : [];
  const envAllowedRoots = [
    ...splitRoots(process.env.CODEXPRO_ALLOWED_ROOTS),
    ...splitRoots(process.env.CODEBASE_BRIDGE_ALLOWED_ROOTS)
  ];

  const allowHome = process.env.CODEXPRO_ALLOW_HOME === "1" || args["allow-home"] === true;
  const requestedAllowed = [defaultRoot, ...allowRootArgs, ...envAllowedRoots, ...(allowHome ? [os.homedir()] : [])];
  // 对所有允许的根目录进行 realpath 解析和去重，确保符号链接路径与真实路径被视为同一目录。
  const allowedRoots = [...new Set(requestedAllowed.map(toRealDir))];

  const portArg = typeof args.port === "string" ? args.port : undefined;
  const hostArg = typeof args.host === "string" ? args.host : undefined;
  const bashArg = typeof args.bash === "string" ? args.bash : undefined;
  const bashTranscriptArg = typeof args["bash-transcript"] === "string" ? args["bash-transcript"] : undefined;
  const bashSessionArg = typeof args["bash-session"] === "string" ? args["bash-session"] : undefined;
  const codexSessionsArg = typeof args["codex-sessions"] === "string" ? args["codex-sessions"] : undefined;
  const codexDirArg = typeof args["codex-dir"] === "string" ? args["codex-dir"] : undefined;
  const requireBashSessionArg =
    args["require-bash-session"] === true
      ? "true"
      : typeof args["require-bash-session"] === "string"
        ? args["require-bash-session"]
        : undefined;
  const writeArg = typeof args.write === "string" ? args.write : undefined;
  const toolModeArg = typeof args["tool-mode"] === "string" ? args["tool-mode"] : undefined;
  const widgetDomainArg = typeof args["widget-domain"] === "string" ? args["widget-domain"] : undefined;
  const toolCardsArg =
    args["tool-cards"] === true
      ? "true"
      : typeof args["tool-cards"] === "string"
        ? args["tool-cards"]
        : undefined;
  const extraBlockedGlobs = splitList(process.env.CODEXPRO_BLOCKED_GLOBS, ",");
  const host = hostArg ?? process.env.CODEXPRO_HOST ?? process.env.HOST ?? "127.0.0.1";
  const authToken = process.env.CODEXPRO_HTTP_TOKEN ?? process.env.CODEBASE_BRIDGE_HTTP_TOKEN;
  // 非回环地址即使设置了 CODEXPRO_ALLOW_NO_HTTP_TOKEN 也不能关闭认证，
  // 防止 CodexPro 在局域网或公网监听时被意外暴露。
  const allowNoToken = boolFrom(process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN, false) && isLoopbackHost(host);
  const requireHttpToken =
    (!authToken && !allowNoToken) ||
    boolFrom(process.env.CODEXPRO_REQUIRE_HTTP_TOKEN, false) ||
    boolFrom(process.env.CODEXPRO_TUNNEL_MODE, false) ||
    (!isLoopbackHost(host) && !allowNoToken);
  const bashSessionId = bashSessionIdFrom(bashSessionArg ?? process.env.CODEXPRO_BASH_SESSION_ID);
  const requireBashSession = boolFrom(requireBashSessionArg ?? process.env.CODEXPRO_REQUIRE_BASH_SESSION, false);
  if (requireBashSession && !bashSessionId) {
    throw new Error("CODEXPRO_REQUIRE_BASH_SESSION requires CODEXPRO_BASH_SESSION_ID or --bash-session.");
  }

  return {
    defaultRoot,
    allowedRoots,
    host,
    port: numberFrom(portArg ?? process.env.CODEXPRO_PORT ?? process.env.PORT, 8787, 1, 65535),
    widgetDomain: widgetDomainFrom(widgetDomainArg ?? process.env.CODEXPRO_WIDGET_DOMAIN),
    authToken,
    requireHttpToken,
    bashMode: bashModeFrom(bashArg ?? process.env.CODEXPRO_BASH_MODE),
    bashTranscript: bashTranscriptFrom(bashTranscriptArg ?? process.env.CODEXPRO_BASH_TRANSCRIPT),
    bashSessionId,
    requireBashSession,
    codexSessions: codexSessionsFrom(codexSessionsArg ?? process.env.CODEXPRO_CODEX_SESSIONS),
    codexDir: expandHome(codexDirArg || process.env.CODEXPRO_CODEX_DIR || path.join(os.homedir(), ".codex")),
    writeMode: writeModeFrom(writeArg ?? process.env.CODEXPRO_WRITE_MODE),
    toolMode: toolModeFrom(toolModeArg ?? process.env.CODEXPRO_TOOL_MODE),
    inheritEnv: process.env.CODEXPRO_INHERIT_ENV === "1",
    maxReadBytes: numberFrom(process.env.CODEXPRO_MAX_READ_BYTES, 180_000, 4_000, 2_000_000),
    maxWriteBytes: numberFrom(process.env.CODEXPRO_MAX_WRITE_BYTES, 1_000_000, 1_000, 10_000_000),
    maxOutputBytes: numberFrom(process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000),
    maxSearchResults: numberFrom(process.env.CODEXPRO_MAX_SEARCH_RESULTS, 200, 5, 2_000),
    maxHttpSessions: numberFrom(process.env.CODEXPRO_MAX_HTTP_SESSIONS, 64, 1, 512),
    httpSessionTtlMs: numberFrom(process.env.CODEXPRO_HTTP_SESSION_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000),
    // DEFAULT_BLOCKED_GLOBS 始终生效，用户追加的规则只能扩展而不能覆盖默认规则。
    blockedGlobs: [...DEFAULT_BLOCKED_GLOBS, ...extraBlockedGlobs],
    contextDir: contextDirFrom(process.env.CODEXPRO_CONTEXT_DIR),
    toolCards: boolFrom(toolCardsArg ?? process.env.CODEXPRO_TOOL_CARDS, false),
    connectionTest: boolFrom(process.env.CODEXPRO_CONNECTION_TEST, false),
    analysisEnabled: boolFrom(process.env.CODEXPRO_ANALYSIS, true),
    analysisLimits: {
      maxInventoryFiles: numberFrom(process.env.CODEXPRO_ANALYSIS_MAX_INVENTORY_FILES, DEFAULT_ANALYSIS_LIMITS.maxInventoryFiles, 100, 100_000),
      maxAnalyzedFiles: numberFrom(process.env.CODEXPRO_ANALYSIS_MAX_ANALYZED_FILES, DEFAULT_ANALYSIS_LIMITS.maxAnalyzedFiles, 10, 50_000),
      maxScannedBytes: numberFrom(process.env.CODEXPRO_ANALYSIS_MAX_SCANNED_BYTES, DEFAULT_ANALYSIS_LIMITS.maxScannedBytes, 1_000_000, 512 * 1024 * 1024),
      maxSymbols: numberFrom(process.env.CODEXPRO_ANALYSIS_MAX_SYMBOLS, DEFAULT_ANALYSIS_LIMITS.maxSymbols, 100, 1_000_000),
      maxRelationships: numberFrom(process.env.CODEXPRO_ANALYSIS_MAX_RELATIONSHIPS, DEFAULT_ANALYSIS_LIMITS.maxRelationships, 100, 2_000_000)
    }
  };
}
