import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { expandHome } from "./config.js";

/**
 * 安全隔离核心模块：Workspace 管理、路径守卫与错误类型。
 *
 * 本文件是 CodexPro 本机权限边界的实现基础。所有文件访问、命令执行
 * 前都必须经过这里的校验。上层调用者（server.ts 中的工具 handler）
 * 通过 WorkspaceManager 获取已登记的 Workspace，再通过 PathGuard
 * 解析用户输入路径，确保路径永远不会逃出允许目录范围。
 *
 * 上游调用者：src/server.ts（MCP 工具 handler）
 * 下游依赖：node:fs、node:path、minimatch
 *
 * MCP 安全设计原则：
 * - Tool description 和 Zod schema 描述的"不允许绝对路径"是给模型看的提示，
 *   不是安全控制。真正的访问控制在本文件中实现。
 * - 客户端发来的 workspace_id 不可直接当路径使用，必须通过 WorkspaceManager
 *   映射为服务端已登记的真实绝对路径。
 *
 * 权限校验链：
 *
 *   客户端 workspace_id
 *           │
 *           ▼
 *   WorkspaceManager.getWorkspace()
 *           │ 映射为已登记的 Workspace
 *           ▼
 *   PathGuard.resolve()
 *           │ 规范化 + 阻止目录穿越 + 符号链接校验 + blockedGlobs 检查
 *           ▼
 *   允许访问的绝对路径（absPath）
 */

/**
 * Workspace 的运行时信息。
 *
 * id 由 root 的 SHA-256 生成，保证不同路径对应不同 id，同路径始终同一 id。
 * root 是经过 realpathSync 解析的规范化真实路径，消除符号链接歧义。
 */
export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
}

/**
 * CodexPro 的应用级错误类型。
 *
 * 工具 handler 抛出此类型时，server.ts 的错误拦截器会将其格式化为
 * MCP Tool Result 的错误内容，同时脱敏后再返回客户端。
 * 区别于普通 Error：可以被识别为"预期的业务错误"而非未处理异常。
 */
export class CodexProError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProError";
  }
}

/**
 * 判断 child 路径是否是 parent 路径的子路径（包含自身）。
 *
 * 使用相对路径计算实现，避免简单字符串前缀匹配的陷阱（例如 /foobar
 * 不应被认为是 /foo 的子路径）。
 */
export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 将路径段分隔符统一为正斜线（/），用于跨平台展示。
 *
 * 空字符串规范化为 "."，代表"当前目录"而不是空路径。
 */
export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

/**
 * 将绝对路径转换为相对于 workspace root 的展示路径（正斜线格式）。
 *
 * 返回的路径仅用于显示和向客户端反馈，不直接用于文件系统操作。
 */
export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

/**
 * 根据 workspace 真实路径生成确定性的 workspace ID。
 *
 * 使用 SHA-256 前 24 位 hex，格式为 "ws_<hex>"。同一 realpath 始终
 * 生成相同 ID，不同路径生成不同 ID，保证幂等性和唯一性。
 * 这里用 realpath 作为输入，确保符号链接和原路径映射到同一 ID。
 */
function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

/**
 * 尝试解析路径的真实路径（follow 所有符号链接）。
 *
 * 路径不存在时返回 undefined，而不是抛出异常，供调用者根据情况处理。
 * 用于在路径可能不存在（如写入目标的父目录）时安全地检查符号链接。
 */
function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync(existingPath);
  } catch {
    return undefined;
  }
}

/**
 * 向上遍历路径，找到最近的已存在的祖先目录。
 *
 * 用于写入操作：写入目标文件可能还不存在，需要检查其最近存在的父目录
 * 是否也在 workspace 内，防止通过符号链接父目录逃逸权限边界。
 */
function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Workspace 注册表：管理已打开的工作区集合。
 *
 * 每个 MCP Server 实例持有一个 WorkspaceManager。客户端必须先调用
 * open_workspace（或 open_current_workspace）打开 Workspace，然后在
 * 后续工具调用中传入返回的 workspace_id。
 *
 * 设计原因：
 * - 禁止客户端直接传入任意文件系统路径作为操作目标。
 * - workspace_id 是服务端颁发的令牌，只有登记过的路径才能通过。
 * - 多 Workspace 场景下，用户可以在不同仓库间切换，每个都独立隔离。
 */
export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly config: CodexProConfig) {}

  /**
   * 获取默认工作区（config 中配置的 defaultRoot 对应的 Workspace）。
   *
   * 如果默认根尚未登记，会自动调用 openWorkspace 登记。用于工具调用
   * 时未提供 workspace_id 的回退行为。
   */
  defaultWorkspace(): Workspace {
    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === this.config.defaultRoot);
    return existing ?? this.openWorkspace(this.config.defaultRoot);
  }

  /**
   * 打开（登记）一个 Workspace。
   *
   * 校验流程：
   * 1. 展开 ~ 路径，解析为绝对路径
   * 2. 确认路径存在且是目录
   * 3. 用 realpathSync 解析真实路径（消除符号链接）
   * 4. 确认真实路径在 allowedRoots 之内（防止通过符号链接逃逸）
   * 5. 若已登记则返回已有记录（幂等）；否则生成 ID 并存入 Map
   *
   * @param rootInput 用户提供的路径字符串（可含 ~，可为 undefined）
   * @returns 已登记的 Workspace 对象
   * @throws CodexProError 路径不存在、不是目录、或超出允许范围时
   */
  openWorkspace(rootInput?: string): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new CodexProError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new CodexProError(`Workspace root is not a directory: ${resolved}`);
    }
    // 解析真实路径：消除符号链接，确保 allowedRoots 校验不被绕过。
    // 例如：用户打开 ~/projects/myapp（实为指向 /data/repos/myapp 的符号链接），
    // 这里会得到 /data/repos/myapp，然后检查 /data/repos/myapp 是否在允许范围内。
    const realRoot = fs.realpathSync(resolved);
    const allowed = this.config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
    if (!allowed) {
      throw new CodexProError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    if (existing) return existing;

    const id = workspaceIdForRoot(realRoot);
    const workspace = { id, root: realRoot, openedAt: new Date().toISOString() };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  /**
   * 通过 workspace_id 获取已登记的 Workspace。
   *
   * 工具参数中的 workspace_id 不能直接被当作文件路径使用。必须先通过
   * 此方法映射为服务端已登记的 Workspace，从而避免客户端绕过允许目录
   * 限制访问任意本机路径。
   *
   * @param id workspace_id（来自 open_workspace 返回值），省略时返回默认 Workspace
   * @throws CodexProError 传入了未知的 workspace_id 时
   */
  getWorkspace(id?: string): Workspace {
    if (!id) return this.defaultWorkspace();
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new CodexProError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    }
    return workspace;
  }

  /**
   * 列出所有已登记的 Workspace。用于 list_workspaces 工具。
   */
  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }
}

/**
 * 路径守卫：在 Workspace 范围内解析、校验用户输入路径。
 *
 * 所有文件读写操作的路径在传入底层 fs 模块前必须经过此类处理。
 * PathGuard 负责：
 * - 防止目录穿越（../ 攻击）
 * - 检查路径是否命中 blockedGlobs（.git、.env、*.key 等）
 * - 检测并阻断通过符号链接逃逸 workspace 的尝试
 * - 写入操作时额外检查父目录链的符号链接
 *
 * PathGuard 不是独立的权限系统；它必须与 WorkspaceManager 配合使用，
 * 后者保证 workspace.root 本身已经通过了 allowedRoots 校验。
 */
export class PathGuard {
  constructor(private readonly config: CodexProConfig) {}

  /**
   * 判断相对路径是否命中任何 blockedGlobs。
   *
   * blockedGlobs 默认包括 .git、node_modules、.env、*.pem、*.key、.ssh 等
   * 敏感路径，防止模型意外读取凭据或内部状态文件。
   * 用户可通过 CODEXPRO_BLOCKED_GLOBS 追加自定义规则。
   */
  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  /**
   * 断言路径未被 blockedGlobs 阻断，否则抛出 CodexProError。
   */
  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new CodexProError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  /**
   * 解析用户输入路径为安全的绝对路径。
   *
   * 这是路径处理的核心方法，所有文件操作必须先调用此方法。
   *
   * 校验流程：
   * 1. 展开 ~ 路径
   * 2. 解析为绝对路径（相对路径基于 workspace.root 展开）
   * 3. 确认不超出 workspace.root 范围（防止 ../ 穿越）
   * 4. 检查 blockedGlobs
   * 5. 如果路径已存在，跟随符号链接验证真实目标仍在 workspace 内
   * 6. 写入模式下，额外检查最近存在的父目录的真实路径
   *
   * @param workspace 已登记的 Workspace
   * @param inputPath 工具参数中的路径字符串
   * @param options.forWrite 是否为写入操作（启用父目录符号链接检查）
   * @returns { absPath, relPath } 经过验证的绝对路径和相对路径
   * @throws CodexProError 任何安全校验失败时
   */
  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    let absPath = path.resolve(candidate);
    // 跟随已存在路径中的符号链接，后续同时校验字符串路径和真实目标路径。
    const realTarget = maybeRealpath(absPath);
    let relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      if (realTarget && isSubpath(realTarget, workspace.root)) {
        absPath = realTarget;
        relPath = displayPath(realTarget, workspace.root);
      } else if (options.forWrite) {
        const parent = closestExistingParent(path.dirname(absPath));
        const realParent = maybeRealpath(parent);
        if (!realParent || !isSubpath(realParent, workspace.root)) {
          throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
        }
        absPath = path.resolve(realParent, path.relative(parent, absPath));
        relPath = displayPath(absPath, workspace.root);
      } else {
        throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
      }
    }

    this.assertNotBlocked(relPath);

    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new CodexProError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    // 写入时的额外检查：目标文件可能不存在，但其父目录可能是指向外部的符号链接。
    // 检查最近存在的祖先目录，确保写入操作的落点也在 workspace 内。
    if (options.forWrite) {
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          throw new CodexProError(`Refusing to write through a symlink: ${inputPath}`);
        }
      } catch (error) {
        if (error instanceof CodexProError) throw error;
      }
      const parent = closestExistingParent(path.dirname(absPath));
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new CodexProError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  /**
   * 断言绝对路径指向的是可读文本文件（非目录、非二进制、未超过大小限制）。
   *
   * 二进制检测：读取文件前 4096 字节，检查是否含有 null 字节（0x00）。
   * 大多数二进制格式（ELF、PNG、PDF 等）都含有 null 字节，因此这是
   * 快速、廉价的启发式过滤，防止模型读入无意义的二进制内容。
   *
   * @param absPath 已经过 resolve() 验证的绝对路径
   * @param maxBytes 允许的最大文件大小（字节）
   * @throws CodexProError 非文件、文件过大、或含二进制内容时
   */
  async assertTextFile(absPath: string, maxBytes: number): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new CodexProError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes) {
      throw new CodexProError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    if (stat.size === 0) return;
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(64 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(sample, 0, sample.length, offset);
        if (bytesRead === 0) break;
        if (sample.subarray(0, bytesRead).includes(0)) {
          throw new CodexProError("Refusing to read binary file.");
        }
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * 返回当前用户的主目录路径。
 *
 * 封装为函数便于在测试中 mock，也避免各模块直接依赖 os.homedir()。
 */
export function userHome(): string {
  return os.homedir();
}
