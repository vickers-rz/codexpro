/**
 * Bash 命令执行模块：受控的本地验证命令执行器。
 *
 * 本模块实现了 bash 工具，但它不是一个通用的远程 Shell 接口。
 * CodexPro 的 bash 工具的设计目标是：
 * "让 AI 能运行构建、测试和代码检查，但不能成为任意命令执行的后门。"
 *
 * 安全模型（多层防御）：
 *
 * ```
 * 模型生成 command
 *       │
 *       ▼
 * 1. BashMode 检查：是否允许使用 bash 工具？
 *       │ off → 直接拒绝
 *       │ full → 跳过 allowlist 检查（适合受信任的本地仓库）
 *       │ safe → 继续
 *       ▼
 * 2. SAFE_BLOCKED_PATTERNS 检查：是否包含高风险操作？
 *       │ 命中 → 直接拒绝（不查 allowlist）
 *       ▼
 * 3. SAFE_ALLOWED_PREFIXES 检查：是否在允许的命令前缀列表中？
 *       │ 不在 → 拒绝，提示使用 read/search/git 工具
 *       ▼
 * 4. BashSession 检查（如已配置）：session_id 是否匹配？
 *       │ 不匹配 → 拒绝
 *       ▼
 * 5. PathGuard 解析 cwd：工作目录是否在 workspace 内？
 *       │ 不在 → 拒绝
 *       ▼
 * 6. 子进程执行（带 timeout 和 cwd 限制）
 *       │
 *       ├─ stdout（截断 + 脱敏）
 *       ├─ stderr（截断 + 脱敏）
 *       ├─ exitCode
 *       └─ timeout / signal
 * ```
 *
 * 为什么 bash 工具不应成为任意远程 Shell？
 * - 任意命令执行 = rm -rf、curl <恶意URL>、cat ~/.ssh/id_rsa 等危险操作
 * - 模型可能被提示注入（prompt injection）诱导执行恶意命令
 * - allowlist 是服务端硬校验，与 Tool description 无关
 *   （即使模型忽略了"只能用于验证"的描述，代码层面的检查仍然生效）
 *
 * 上游调用者：src/server.ts（bash 工具 handler）
 * 下游依赖：node:child_process（spawn）、src/guard.ts、src/redact.ts
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

/**
 * Bash 命令执行结果。
 *
 * 包含完整的执行上下文：命令本身、工作目录、退出信息、输出内容和计时。
 * exitCode 和 signal 互斥：正常退出时 signal 为 null，被信号终止时 exitCode 可能为 null。
 */
export interface BashResult {
  /** 执行的命令字符串（原始输入）。 */
  command: string;
  /** 实际执行时的工作目录（相对于 workspace root）。 */
  cwd: string;
  /** 进程退出码（被信号终止时为 null）。 */
  exitCode: number | null;
  /** 终止进程的信号（正常退出时为 null）。 */
  signal: NodeJS.Signals | null;
  /** 命令执行耗时（毫秒）。 */
  durationMs: number;
  /** 标准输出（已截断 + 脱敏）。 */
  stdout: string;
  /** 标准错误（已截断 + 脱敏）。 */
  stderr: string;
  /** 输出是否因超过大小限制而被截断。 */
  truncated: boolean;
  /** 会话 ID（当服务端配置了 bashSessionId 时返回，用于审计）。 */
  bashSessionId?: string;
}

/**
 * safe 模式下的命令允许列表（前缀匹配）。
 *
 * 这里列出的命令都是"验证型"操作：读取状态、执行测试、检查类型和代码风格。
 * 它们的共同特点：
 * - 不修改文件系统（test、lint、typecheck 只读取代码）
 * - 不进行网络操作（git 操作限于本地）
 * - 不需要提升权限
 * - 执行结果可预测且可复现
 *
 * 为什么 build 也在列表中？
 * - 构建过程通常只在 dist/ 等构建输出目录写入文件
 * - dist/ 默认在 blockedGlobs 中（PathGuard 不允许读取），但不影响构建命令本身
 * - 知道"是否能成功编译"对 AI 辅助编程来说是重要的验证步骤
 *
 * 注意：allowlist 基于命令前缀匹配，而不是精确匹配。这意味着：
 * - "npm run build" 匹配，"npm run build:prod" 也匹配（因为以前者开头）
 * - isAllowedPackageScript 处理了更灵活的 "npm run <script>:<variant>" 模式
 */
const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

/**
 * safe 模式下的命令阻断模式（正则表达式列表）。
 *
 * 即使命令以允许的前缀开头，只要命中以下任一模式，也会被拒绝。
 * 阻断模式优先于允许列表（先检查阻断，再检查允许）。
 *
 * 主要阻断类别：
 * 1. 破坏性文件操作：rm、mv、cp、dd
 * 2. 权限提升：sudo、chmod、chown
 * 3. 进程管理：kill、pkill
 * 4. 网络操作：curl、wget、ssh、scp、rsync
 * 5. 容器操作：docker、podman
 * 6. 危险 Git 操作：push、reset、clean、checkout（写入 Git 历史或状态）
 * 7. 包发布：npm/pnpm/yarn publish
 * 8. 敏感路径访问：.env、.git、node_modules、.ssh、私钥文件
 * 9. find 的危险动作：-exec、-delete 等
 * 10. 文件读取工具：cat、grep、rg、head、tail、wc（这些操作应使用专用工具）
 * 11. Shell 特殊语法：;、&、|、<、>、`（命令链、管道、重定向、命令替换）
 * 12. 环境变量展开：$VAR（防止注入）
 * 13. 多行命令：\n（防止隐藏的第二条命令）
 *
 * 为什么禁止 cat、grep、rg？
 * 这些命令应通过 read、search 工具完成，后者受 PathGuard 和脱敏保护。
 * 在 bash 中直接使用这些命令绕过了安全层。
 *
 * 为什么禁止 Shell 操作符（; & | < > `）？
 * 命令链和管道允许将多个命令组合，使 allowlist 的前缀匹配失去意义。
 * 例如：允许 "npm test" 后，"npm test; rm -rf /" 也会以允许前缀开头。
 */
const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /[\r\n]/
];

/**
 * 规范化命令字符串：去除首尾空白，将连续空白压缩为单个空格。
 *
 * 规范化后才与 allowlist 和 blocklist 比较，防止使用多余空格绕过检查。
 */
function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * 检查命令是否以允许的前缀开头。
 *
 * 先检查通用的 isAllowedPackageScript（处理 "npm run build:clients" 等变体），
 * 再检查静态 SAFE_ALLOWED_PREFIXES 列表。
 *
 * 前缀匹配要求命令等于前缀，或以"前缀 + 空格"开头，防止：
 * - "npm testevil" 被错误匹配（因为 "npm test" 是前缀）
 * - 通过添加前缀绕过检查
 */
function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

/**
 * 检查是否是允许的包管理器脚本命令（带子命令变体）。
 *
 * 允许格式：<pm> run <verb>[:<variant>] [-- <flags>]
 * - pm：npm、pnpm、yarn、bun
 * - verb：test、typecheck、lint、build、check
 * - variant：可选的冒号分隔子命令（如 build:prod、test:unit）
 * - 双横线后允许传入字母数字参数（如 --reporter、--watch=false）
 *
 * 此正则防止使用 "npm run evil-script"，但允许 "npm run build:esm"。
 */
function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

/**
 * 校验命令是否符合当前 BashMode 的安全策略。
 *
 * 三种 BashMode 的处理逻辑：
 * - "off"：立即拒绝所有命令（bash 工具未启用）
 * - "full"：跳过所有检查，直接执行（适用于完全受信任的本地环境）
 * - "safe"：先检查 SAFE_BLOCKED_PATTERNS，再检查 SAFE_ALLOWED_PREFIXES
 *
 * 重要：Tool description 中的说明（如"只能运行验证命令"）对模型是提示，
 * 但不是安全控制。即使模型忽略描述，这里的硬检查仍然生效。
 *
 * @throws CodexProError 命令被阻断时
 */
function assertSafeCommand(config: CodexProConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized)) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }
}

/**
 * 校验 Bash 会话 ID（当服务端配置了 bashSessionId 时）。
 *
 * 会话 ID 机制用于多模型或多标签场景：用户可以配置一个会话 ID，
 * 确保只有知道这个 ID 的调用方才能执行 bash 命令。这提供了额外的
 * 审计粒度，但不是严格的安全控制（ID 可能通过工具结果泄露）。
 *
 * 行为矩阵：
 * | requireBashSession | 有配置 ID | 请求 ID | 结果 |
 * |-------------------|----------|---------|------|
 * | true              | 无        | 任意    | 报错：服务端未配置 |
 * | true              | 有        | 空      | 报错：要求提供 ID |
 * | true              | 有        | 不匹配  | 报错：ID 不符 |
 * | false             | 无        | 任意    | 允许（不检查） |
 * | false             | 有        | 空      | 允许（使用服务端 ID） |
 * | false             | 有        | 不匹配  | 报错：ID 不符 |
 *
 * @returns 实际使用的 session ID（用于审计记录），或 undefined
 */
function assertBashSession(config: CodexProConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

/**
 * 构建子进程的环境变量集合。
 *
 * 两种模式：
 * - inheritEnv=true：子进程继承完整的父进程环境（包括 PATH、API keys 等）
 * - inheritEnv=false（默认）：构造最小化环境（仅包含必要的 PATH、HOME 等）
 *
 * 最小化环境的安全优势：
 * - 子进程不会"意外"访问到父进程环境中的 API keys、数据库密码等敏感变量
 * - 即使命令被 prompt injection 操控，也无法通过 process.env 泄露密钥
 *
 * 无论哪种模式，都会强制设置：
 * - NO_COLOR=1：禁用颜色转义码（保持输出纯文本）
 * - CI=1：让工具知道在 CI-like 环境中运行（减少交互式提示）
 */
function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" };
  }
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
}

/**
 * 返回可用的 bash 可执行文件路径。
 *
 * 优先使用 /bin/bash（标准位置），回退到 PATH 中的 bash。
 * 使用 bash 而非 sh 是为了支持更多的现代 bash 语法（数组、[[、等）。
 */
function bashExecutable(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

/**
 * 截断输出内容到指定字节数，保持 UTF-8 字符边界。
 *
 * 使用 Buffer 而非字符串长度，确保多字节字符不会被截断到一半。
 * 截断时追加提示消息，让模型知道输出不完整。
 */
function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

/**
 * 在受控环境中执行 Bash 命令。
 *
 * 执行流程：
 * 1. 命令非空校验
 * 2. BashSession 校验（如已配置）
 * 3. 命令安全校验（BashMode + allowlist + blocklist）
 * 4. 通过 PathGuard 解析 cwd（确保在 workspace 内）
 * 5. 创建子进程（bash -lc <command>）
 * 6. 实时监控输出大小（超过 2x maxOutputBytes 时立即终止）
 * 7. 超时处理（先 SIGTERM，1.5 秒后若仍运行则 SIGKILL）
 * 8. 输出截断 + 脱敏
 * 9. 返回完整的 BashResult
 *
 * 子进程以 "bash -lc" 启动：
 * - "-l"（login shell）：加载 ~/.bash_profile 或 ~/.bashrc，确保 PATH 正确
 * - "-c"：将后续字符串作为命令执行
 *
 * stdin 设为 "ignore"：子进程不能从 stdin 读取，防止交互式命令挂起。
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例（用于 cwd 校验）
 * @param workspace 已登记的 Workspace
 * @param command 要执行的命令字符串
 * @param options.cwd 子进程工作目录（相对于 workspace root，默认 "."）
 * @param options.timeoutMs 超时时间（毫秒，1000-180000，默认 30000）
 * @param options.sessionId 调用方提供的 session ID（可选）
 */
export async function runBash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number; sessionId?: string } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  // 超时时间被限制在 1-180 秒之间，防止极短或极长的超时设置。
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 180_000));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(bashExecutable(), ["-lc", command], {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
      // SIGKILL 作为后备：某些进程会忽略 SIGTERM，1.5 秒后强制终止。
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      // 实时监控输出大小：超过 2x 限制时立即终止，防止内存耗尽。
      if (Buffer.byteLength(stdout, "utf8") > config.maxOutputBytes * 2) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, "utf8") > config.maxOutputBytes * 2) child.kill("SIGTERM");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        stderr += `\n[codexpro] Command timed out after ${timeoutMs} ms.`;
      }
      // 输出截断后再脱敏（而非脱敏后截断），确保截断不会切断脱敏模式的一半。
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        command,
        // 返回相对路径而非绝对路径，减少路径信息泄露。
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: out.truncated || err.truncated,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}
