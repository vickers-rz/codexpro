/**
 * Profile 持久化存储模块：保存和读取工作区启动配置文件。
 *
 * Profile 是 CodexPro 的可持久化启动配置，存储用户对特定工作区选择的
 * 连接方式、Bash 模式、隧道类型等偏好设置。通过 Profile，用户不必每次
 * 启动时重复输入所有参数，codexpro 脚本可以从上次的配置继续运行。
 *
 * Profile 与运行时配置（CodexProConfig）的关系：
 * - CodexProConfig：进程运行时的实际生效配置，由 loadConfig() 在启动时构建，不可变。
 * - WorkspaceProfile：存储在磁盘上的用户偏好，可在启动脚本中读取并作为参数传入。
 * - RuntimeConnection：运行时状态，记录当前进程的实际监听地址和连接端点。
 *
 * 数据存储位置：
 * - ~/.codexpro/profiles/<hash>.json — 按 workspace root 的 SHA-256 存储 Profile
 * - ~/.codexpro/runtime/<hash>.json — 记录当前进程的运行时连接信息
 *
 * 安全说明：
 * - Profile 文件权限设为 0o600（仅所有者可读写），防止其他用户读取 token。
 * - Profile 中存储的 token 在通过 MCP 工具返回前会被脱敏（sanitizeWorkspaceProfile）。
 * - Profile 目录权限设为 0o700，防止目录枚举。
 *
 * 上游调用者：scripts/codexpro.mjs（启动脚本），src/server.ts（settings 相关工具）
 * 下游依赖：node:fs、node:crypto、node:path
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BashMode, BashTranscriptMode, CodexSessionsMode, ToolMode, WriteMode } from "./config.js";
import { expandHome } from "./config.js";

/**
 * 隧道类型枚举：
 * - "none"：不使用隧道，只在本地监听。
 * - "cloudflare"：使用 cloudflared 创建临时隧道（每次 URL 不同）。
 * - "cloudflare-named"：使用命名隧道（固定 URL，需要预配置）。
 * - "ngrok"：使用 ngrok 创建隧道。
 * - "tailscale"：使用 Tailscale Funnel 暴露稳定 HTTPS 入口。
 */
export type TunnelMode = "none" | "cloudflare" | "cloudflare-named" | "ngrok" | "tailscale";

/**
 * 连接器模式，影响 ChatGPT Connector 的配置提示：
 * - "agent"：完整 Agent 模式，展示所有工具。
 * - "handoff"：Handoff 模式，重点展示 handoff 工具。
 * - "pro"：Pro Context 模式，重点展示上下文导出工具。
 */
export type ConnectorMode = "agent" | "handoff" | "pro";

/**
 * 工作区持久化 Profile：用户对特定 workspace 的启动偏好设置。
 *
 * 所有字段均可选，缺失字段将使用代码默认值。
 * Profile 主要被启动脚本（codexpro.mjs）读取，在构建命令行参数时使用。
 */
export interface WorkspaceProfile {
  version?: number;
  root?: string;
  updatedAt?: string;
  /** Profile 文件的绝对路径（读取时自动填充，保存时忽略） */
  profilePath?: string;
  port?: string;
  /** 连接器模式 */
  mode?: ConnectorMode | string;
  /** 隧道类型 */
  tunnel?: TunnelMode | string;
  /** 自定义 hostname（用于隧道） */
  hostname?: string;
  tunnelName?: string;
  ngrokConfig?: string;
  cloudflareConfig?: string;
  cloudflareTokenFile?: string;
  /** Cloudflare 隧道 token（存储前应妥善保护，读取时会脱敏） */
  cloudflareToken?: string;
  /** HTTP Bearer Token（存储前应妥善保护，读取时会脱敏） */
  token?: string;
  bash?: BashMode | string;
  bashTranscript?: BashTranscriptMode | string;
  codexSessions?: CodexSessionsMode | string;
  codexDir?: string;
  bashSession?: string;
  requireBashSession?: boolean;
  write?: WriteMode | string;
  toolMode?: ToolMode | string;
  toolCards?: boolean;
  widgetDomain?: string;
  noInstallCloudflared?: boolean;
}

/**
 * 运行时连接状态：记录当前进程的实际连接信息。
 *
 * 在进程启动后写入 ~/.codexpro/runtime/<hash>.json，
 * 供 codexpro doctor、status 检查命令读取，判断进程是否仍在运行。
 */
export interface RuntimeConnection {
  version?: number;
  root?: string;
  updatedAt?: string;
  /** 公开访问端点（隧道 URL 或本地 URL） */
  endpoint?: string;
  /** 本地监听基地址 */
  localBase?: string;
  /** 本地 status 检查 URL */
  localStatusUrl?: string;
  tunnel?: TunnelMode | string;
  mode?: ConnectorMode | string;
  bash?: BashMode | string;
  bashTranscript?: BashTranscriptMode | string;
  codexSessions?: CodexSessionsMode | string;
  bashSession?: string;
  requireBashSession?: boolean;
  write?: WriteMode | string;
  toolMode?: ToolMode | string;
  toolCards?: boolean;
}

/**
 * 返回 CodexPro 数据目录。
 *
 * 默认为 ~/.codexpro，可通过 CODEXPRO_HOME 环境变量覆盖。
 * 此目录存放 profiles/（用户配置）和 runtime/（进程状态）两个子目录。
 */
export function codexProHome(): string {
  const customHome = process.env.CODEXPRO_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), ".codexpro");
}

/** 返回 Profile 存储目录（~/.codexpro/profiles/）。 */
export function profileDir(): string {
  return path.join(codexProHome(), "profiles");
}

/**
 * 根据 workspace root 路径计算 Profile ID（SHA-256 前 24 位 hex）。
 *
 * 与 WorkspaceManager.workspaceIdForRoot 使用相同的哈希算法，
 * 确保同一 workspace 的 Profile 和 Workspace ID 可以相互对应。
 */
export function profileIdForRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

/** 返回特定 workspace 的 Profile 文件路径。 */
export function profilePathForRoot(root: string): string {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

/** 返回运行时状态存储目录（~/.codexpro/runtime/）。 */
export function runtimeDir(): string {
  return path.join(codexProHome(), "runtime");
}

/** 返回特定 workspace 的运行时状态文件路径。 */
export function runtimeStatusPathForRoot(root: string): string {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.json`);
}

/**
 * 读取 JSON 文件，返回解析后的对象。
 *
 * 文件不存在时返回空对象 {}（而非抛出异常），简化调用方的空值处理。
 * JSON 格式错误或其他读取失败时重新抛出，避免静默地使用损坏的配置。
 */
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * 读取特定 workspace 的 Profile 配置。
 *
 * 容错处理：
 * - Profile 文件不存在 → 返回 {}（未配置，使用默认值）
 * - Profile 格式非对象 → 返回 {}（损坏保护）
 * - Profile 中的 root 与传入 root 不匹配 → 返回 {}（防止哈希碰撞误用）
 *
 * @param root workspace 的真实路径
 * @returns WorkspaceProfile 对象（可能是空对象 {}）
 */
export function readWorkspaceProfile(root: string): WorkspaceProfile {
  const profilePath = profilePathForRoot(root);
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const typed = profile as WorkspaceProfile;
  if (typed.root && typed.root !== root) return {};
  return { ...typed, profilePath };
}

/**
 * 保存 workspace Profile 到磁盘。
 *
 * 写入策略（原子性与安全性）：
 * - 创建 profiles/ 目录（权限 0o700，仅所有者可访问目录）
 * - 以模式 0o600 写入 JSON 文件（仅所有者可读写）
 * - 写入后调用 chmod 修复权限（某些文件系统可能继承了不当的 umask）
 *
 * 注意：当前实现使用 writeFileSync 直接写入，不是真正的原子写入
 * （理想做法是写入临时文件后 rename）。对于 Profile 场景（低频写入），
 * 这个简化通常可以接受。
 *
 * @param root workspace 真实路径
 * @param profile 要保存的 Profile 配置
 * @returns 写入的文件路径
 */
export function saveWorkspaceProfile(root: string, profile: WorkspaceProfile): string {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  // profilePath 是运行时添加的字段，不应持久化到文件。
  const { profilePath: _profilePath, ...rest } = profile;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: WorkspaceProfile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...rest,
    root
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission repair for filesystems that support chmod.
  }
  return filePath;
}

/**
 * 脱敏 WorkspaceProfile，用于通过 MCP 工具返回 Profile 内容时。
 *
 * token 和 cloudflareToken 是敏感凭据，不应通过 MCP 接口明文返回。
 * 脱敏后用 "<saved>" 标记代替，让调用方知道这些字段有值但不暴露具体内容。
 *
 * @param profile 原始 Profile
 * @returns 脱敏后的 Profile（不修改原对象）
 */
export function sanitizeWorkspaceProfile(profile: WorkspaceProfile): WorkspaceProfile {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: "<saved>" } : {}),
    ...(cloudflareToken ? { cloudflareToken: "<saved>" } : {})
  };
}

/**
 * 读取特定 workspace 的运行时连接状态。
 *
 * 与 readWorkspaceProfile 类似，在文件不存在或格式错误时返回 {}。
 * root 字段校验防止哈希碰撞导致的误读。
 *
 * @param root workspace 真实路径
 * @returns RuntimeConnection 对象（可能是空对象 {}）
 */
export function readRuntimeConnection(root: string): RuntimeConnection {
  const runtimePath = runtimeStatusPathForRoot(root);
  if (!fs.existsSync(runtimePath)) return {};
  const runtime = readJsonFile(runtimePath);
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return {};
  const typed = runtime as RuntimeConnection;
  if (typed.root && typed.root !== root) return {};
  return typed;
}
