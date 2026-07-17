/**
 * Git 只读操作模块：提供结构化的 Git 状态查询能力。
 *
 * 本模块封装了 git status、git diff 和 git log 三个只读操作，
 * 通过结构化参数构造 Git 命令，而不是接受任意命令字符串。
 *
 * 为什么 Git 操作需要专门的工具，而不是通过 bash 工具执行？
 *
 * 1. 更小的攻击面：bash 工具在 "safe" 模式下已经允许 git status/diff/log，
 *    但允许整个 git 命令族意味着更大的风险。专用工具只暴露明确的只读操作。
 *
 * 2. 更稳定的输出格式：git 命令的输出格式受 locale、配置和别名影响。
 *    这里显式传入 --no-color、--no-ext-diff 等参数，确保输出格式一致可解析。
 *
 * 3. 更明确的权限语义：tool annotations 中 readOnlyHint=true 清晰表达只读意图，
 *    而 bash 工具的 BASH_ANNOTATIONS 标记了 destructiveHint=true（因为 bash 本身
 *    在 full 模式下可以执行破坏性操作）。
 *
 * 4. 更容易审批：ChatGPT 和其他 MCP 客户端的用户审批 UI 可以基于工具名称和
 *    annotations 给出更具体的提示，专用 Git 工具比通用 bash 更容易让用户放心。
 *
 * 不开放写入操作（git commit、git push 等）的原因：
 * - 写入操作不可逆（至少需要 git reset 才能撤销）
 * - 意外的 push 可能影响远程仓库和其他协作者
 * - 计划 + 审查的工作流（handoff）比 AI 自动提交更安全
 *
 * 上游调用者：src/server.ts（git_status、git_diff、show_changes 工具 handler）
 *             src/workspaceOps.ts（workspaceSummary 中调用）
 *             src/proContext.ts（buildProContext 中调用）
 * 下游依赖：node:child_process（spawnSync）
 */

import { spawnSync } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

/**
 * 执行 Git 命令并返回输出文本（内部辅助函数）。
 *
 * 使用 spawnSync（同步）而非 spawn（异步），因为 Git 操作通常很快，
 * 同步方式简化了错误处理和返回值处理。
 *
 * 输出处理：
 * - 命令不可用（git 未安装）时返回友好错误文本而非抛出异常
 * - 非零退出码时返回 stderr 或 stdout 内容（git 的错误通常在 stderr）
 * - 成功输出经过 redactSensitiveText 脱敏（git log 中可能出现密钥）
 * - 输出为空时返回 "(no output)" 而非空字符串，保证调用方不会误判
 *
 * @param workspace 已登记的 Workspace（git 命令在 workspace.root 执行）
 * @param args git 命令参数数组（如 ["status", "--short"]）
 * @param maxOutputBytes 最大输出字节数（通过 maxBuffer 限制）
 */
function runGit(workspace: Workspace, args: string[], maxOutputBytes: number): string {
  // Do not infer repository membership from the requested command's output.
  // Some Git versions/configurations can produce empty output for commands run
  // outside a work tree, which is indistinguishable from a clean diff. An
  // explicit preflight preserves a useful diagnostic for every Git tool.
  const preflight = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspace.root,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (preflight.error) {
    return `git unavailable or failed: ${preflight.error.message}`;
  }
  if (preflight.status !== 0 || preflight.stdout.trim() !== "true") {
    const stderr = preflight.stderr?.trim() || "";
    const stdout = preflight.stdout?.trim() || "";
    const detail = stderr || stdout || "not a git repository (or any parent directory)";
    // Git diagnostics are localized by the host environment. Prefix the original
    // message with a stable token so callers can detect failures without matching
    // every possible locale while still retaining the native diagnostic text.
    return `fatal: git repository check failed: ${detail}`;
  }

  const result = spawnSync("git", args, {
    cwd: workspace.root,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.error) {
    return `git unavailable or failed: ${result.error.message}`;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return stderr || stdout || `git exited with status ${result.status}`;
  }
  return redactSensitiveText(result.stdout.trim() || "(no output)");
}

/** 判断 Git 输出是否代表命令失败，而不是正常的空结果。 */
function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

/** 将 Git 的多行输出规范化为非空行数组，供状态结果组合使用。 */
function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 获取 workspace 的 Git 状态。
 *
 * 默认使用 `git status --short --branch`；当 staged=true 时改用
 * `git diff --cached --name-status`，只列出暂存区中的文件变化。
 * filePath 必须先经过 PathGuard，防止路径逃逸。
 */
export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

/**
 * 获取 workspace 的 Git diff（对应 git diff 或 git diff --staged）。
 *
 * 参数说明：
 * - --no-color：禁用颜色转义码，确保输出是纯文本
 * - --no-ext-diff：禁用 textconv 外部差异工具，避免调用第三方程序
 * - --no-textconv：不对二进制文件执行文本转换
 * - --staged：当 staged=true 时查看已暂存的 diff
 *
 * 为什么不允许任意 git diff 参数？
 * 防止通过参数注入调用任意 git 子命令或访问工作区外的文件。
 * filePath 必须经过 PathGuard 校验，确保只 diff workspace 内的文件。
 *
 * @param config 运行时配置
 * @param guard PathGuard 实例
 * @param workspace 已登记的 Workspace
 * @param filePath 可选的文件路径限定
 * @param staged 是否查看已暂存（staged）的 diff，默认为未暂存（unstaged）
 */
export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

/**
 * 返回用于变更概览的文件级状态。
 *
 * 未暂存模式下额外合并未跟踪文件，因为 `git diff --name-status` 本身不会列出它们；
 * 暂存模式只返回 index 中的变化。
 */
export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
    untrackedArgs.push("--", resolved.relPath);
  }
  const diffStatus = runGit(workspace, args, config.maxOutputBytes);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = runGit(workspace, untrackedArgs, config.maxOutputBytes);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

/**
 * 获取最近的 Git 提交历史（对应 git log --oneline --decorate）。
 *
 * maxCount 被限制在 1-30 之间，防止返回过长的提交历史占用 context 窗口。
 * --oneline 保证每条提交只占一行，便于模型快速理解提交历史。
 * --decorate 显示分支和标签信息，帮助模型了解当前位置。
 */
export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

/**
 * 预留函数：写入前的 Git 清洁度检查钩子。
 *
 * 当前版本不实施任何检查（直接返回）。保留此函数为未来的策略扩展留出接入点，
 * 例如：要求在 git 工作区干净的情况下才允许写入，或在有未提交改动时警告用户。
 *
 * 函数签名故意接受 workspace 参数（用 _ 前缀标记未使用），保持接口稳定性。
 */
export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
