/**
 * 能力发现模块：枚举 CodexPro 的 Skill 清单和 MCP Server 列表。
 *
 * "Skill" 是 CodexPro 的可插拔知识单元，通常是一个 SKILL.md 文件，
 * 描述特定场景下的工作流程（例如：如何进行代码审查、如何添加 API 端点等）。
 * Agent 可以通过 load_skill 工具加载 Skill 内容，注入到上下文中作为执行指南。
 *
 * Skill 的发现路径（优先级从低到高，工作区级 > 用户级 > 插件级）：
 *   ~/.codex/plugins/cache/**（插件缓存 — 最低优先级）
 *   ~/.codex/skills/、~/.agents/skills/（用户级）
 *   <workspace>/.codex/skills/、<workspace>/.agents/skills/、<workspace>/skills/（工作区级 — 最高）
 *
 * 同名 Skill 时，`compareSkills` 的排序保证工作区级版本排在前面，
 * 调用方可以通过 source + path 精确选取。
 *
 * MCP Server 发现：扫描 ~/.codex/config.toml（TOML 格式）和
 * <workspace>/.mcp.json、~/.cursor/mcp.json（JSON 格式）中的
 * [mcpServers] / [mcp_servers] 条目，仅提取服务名称（不暴露地址/凭据）。
 *
 * 上游调用者：src/server.ts（codexpro_inventory、load_skill 工具 handler）
 *             src/workspaceOps.ts（workspaceSummary 中调用 discoverSkillInventory）
 * 下游依赖：node:fs、node:path
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { isSubpath, type Workspace } from "./guard.js";

/**
 * Skill 清单条目：可公开给调用方的 Skill 元数据。
 *
 * `path` 使用 `$WORKSPACE/` 或 `~/` 前缀格式，便于调用方区分来源，
 * 同时不暴露系统的绝对路径。
 */
export interface SkillInventoryItem {
  name: string;
  description?: string;
  source: "workspace" | "user" | "plugin" | "other";
  path: string;
}

/**
 * 内部 Skill 记录：在 discoverSkillRecords 中使用，额外保存绝对路径。
 *
 * absPath 仅在服务端内部用于读取文件内容，不对外暴露。
 * 对外暴露时通过 publicSkill() 转换为 SkillInventoryItem（只含相对路径）。
 */
interface SkillInventoryRecord extends SkillInventoryItem {
  absPath: string;
}

/**
 * load_skill 工具的返回值：Skill 文件内容 + 元数据 + 截断信息。
 *
 * `bytes` 和 `totalBytes` 用于告知调用方是否需要增加 max_bytes 才能获取完整内容。
 * `truncated=true` 时，text 末尾会添加截断提示，让模型知道内容不完整。
 */
export interface LoadedSkill {
  skill: SkillInventoryItem;
  text: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

/**
 * MCP Server 清单条目：服务名称 + 来源文件路径。
 *
 * 只暴露名称，不暴露地址或任何凭据（JSON 中可能含有 env 字段存储 API Key）。
 * `source` 是 displayPath 格式，指向发现该服务名称的配置文件路径。
 */
export interface McpServerInventoryItem {
  name: string;
  source: string;
}

const MAX_MCP_SERVER_INVENTORY = 120;

/**
 * 通用去重函数：通过 key 函数提取唯一键，保留每个键的第一个条目。
 * 用于 Skill 记录（source:name:path）和 MCP Server（source:name）的去重。
 */
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/**
 * 安全读取文本文件（最多 maxBytes 字节），通过 file handle 避免将大文件完全加载进内存。
 * 用于读取 SKILL.md 元数据和 MCP config 文件（JSON/TOML）的头部内容。
 */
async function safeReadText(file: string, maxBytes = 16_000): Promise<string> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * 读取文本文件并附带统计信息（实际读取字节数 vs 文件总字节数）。
 *
 * 与 safeReadText 的区别：返回额外的 bytes/totalBytes/truncated，
 * 供 load_skill 工具向调用方说明内容是否完整。
 * 调用方可根据 truncated 决定是否需要用更大的 max_bytes 重新加载。
 */
async function readTextWithStats(file: string, maxBytes: number): Promise<{ text: string; bytes: number; totalBytes: number; truncated: boolean }> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, "r");
  try {
    const limit = Math.max(1, Math.min(maxBytes, stat.size));
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: bytesRead,
      totalBytes: stat.size,
      truncated: stat.size > bytesRead
    };
  } finally {
    await handle.close();
  }
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function realpathOrUndefined(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

/**
 * 将绝对路径转换为用户友好的展示路径（$WORKSPACE/... 或 ~/...）。
 *
 * 本模块内的 displayPath 与 guard.ts 的同名函数功能类似但实现不同：
 * - guard.ts 版本：纯相对路径（用于文件系统操作）
 * - 本版本：带 $WORKSPACE 或 ~ 前缀（用于向调用方展示路径来源）
 */
function displayPath(absPath: string, workspaceRoot: string): string {
  const home = os.homedir();
  if (absPath === workspaceRoot) return "$WORKSPACE";
  if (absPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return `$WORKSPACE/${path.relative(workspaceRoot, absPath).split(path.sep).join("/")}`;
  }
  if (absPath === home) return "~";
  if (absPath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absPath).split(path.sep).join("/")}`;
  }
  return absPath;
}

/**
 * 根据 SKILL.md 的绝对路径判断 Skill 的来源类型。
 *
 * 分类逻辑：
 * - 在 workspace 根目录下 → "workspace"（项目专属 Skill）
 * - 路径中含 .codex/plugins/ → "plugin"（插件提供的 Skill）
 * - 在用户主目录下（但非 workspace）→ "user"（用户个人 Skill）
 * - 其他 → "other"（绝对路径来源不明确的 Skill）
 */
function skillSource(skillPath: string, workspaceRoot: string): SkillInventoryItem["source"] {
  if (skillPath.startsWith(`${workspaceRoot}${path.sep}`)) return "workspace";
  if (skillPath.includes(`${path.sep}.codex${path.sep}plugins${path.sep}`)) return "plugin";
  if (skillPath.startsWith(`${os.homedir()}${path.sep}`)) return "user";
  return "other";
}

/**
 * Skill 来源优先级排序：workspace > user > plugin > other。
 * 用于 compareSkills，确保工作区专属 Skill 优先出现在列表顶部。
 */
function skillSourceRank(source: SkillInventoryItem["source"]): number {
  if (source === "workspace") return 0;
  if (source === "user") return 1;
  if (source === "plugin") return 2;
  return 3;
}

/**
 * Skill 列表排序函数：先按来源优先级，再按名称字母序，最后按路径区分同名同源。
 */
function compareSkills(a: SkillInventoryItem, b: SkillInventoryItem): number {
  return (
    skillSourceRank(a.source) - skillSourceRank(b.source) ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path)
  );
}

/**
 * 将内部 SkillInventoryRecord 转换为对外安全的 SkillInventoryItem，丢弃 absPath。
 *
 * absPath 是服务端内部信息，不应暴露给 MCP 客户端（避免泄露文件系统布局）。
 */
function publicSkill(record: SkillInventoryRecord): SkillInventoryItem {
  return {
    name: record.name,
    description: record.description,
    source: record.source,
    path: record.path
  };
}

/**
 * 从 YAML front matter 中提取指定键的字符串值。
 *
 * 仅支持简单的 key: value 格式（不支持嵌套或多行值）。
 * 用于从 SKILL.md 中读取 name 和 description 字段。
 * 去除首尾的引号（单引号或双引号）。
 */
function frontmatterValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

/**
 * 递归查找所有 SKILL.md 文件（DFS，深度限制防止过深递归）。
 *
 * 跳过 node_modules 和 .git 目录（性能 + 安全原因）。
 * 插件缓存目录（.codex/plugins/cache）允许更深的递归深度（9层），
 * 因为插件的 Skill 通常嵌套在 <plugin>/<skill_name>/SKILL.md 路径下。
 * 普通 skills/ 目录限制 3 层，够用且不会扫描太深。
 */
async function findSkillFiles(root: string, maxDepth: number, out: string[], maxItems: number): Promise<void> {
  if (out.length >= maxItems || maxDepth < 0) return;
  const entries = await safeReaddir(root);
  for (const entry of entries) {
    if (out.length >= maxItems) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(abs);
      continue;
    }
    if (entry.isDirectory()) {
      await findSkillFiles(abs, maxDepth - 1, out, maxItems);
    }
  }
}

/**
 * 发现并构建完整的 Skill 内部记录列表（含 absPath）。
 *
 * 搜索根目录顺序（按优先级从高到低，compareSkills 保证排序正确）：
 * 1. <workspace>/.codex/skills/（工作区专属）
 * 2. <workspace>/.agents/skills/（工作区通用 Agent Skill）
 * 3. <workspace>/skills/（通用位置）
 * 4. ~/.codex/skills/（用户级，includeGlobal=true 时）
 * 5. ~/.agents/skills/（用户级，includeGlobal=true 时）
 * 6. ~/.codex/plugins/cache（插件缓存，includeGlobal=true 时，允许 9 层深度）
 *
 * 已不存在的目录会被 filter 掉，不会报错（Skill 目录是可选的）。
 */
async function discoverSkillRecords(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryRecord[]> {
  const maxSkills = Math.max(1, Math.min(options.maxSkills ?? 120, 500));
  const workspaceRoots = [
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, ".agents", "skills"),
    path.join(workspace.root, "skills")
  ].flatMap((dir) => {
    const real = realpathOrUndefined(dir);
    return real && isSubpath(real, workspace.root) ? [real] : [];
  });
  const roots = [
    ...workspaceRoots,
    ...(options.includeGlobal
      ? [
          path.join(os.homedir(), ".codex", "skills"),
          path.join(os.homedir(), ".agents", "skills"),
          path.join(os.homedir(), ".codex", "plugins", "cache")
        ]
      : [])
  ].filter((dir) => fs.existsSync(dir));

  const skillFiles: string[] = [];
  for (const root of roots) {
    await findSkillFiles(root, root.includes(`${path.sep}plugins${path.sep}cache`) ? 9 : 3, skillFiles, maxSkills);
    if (skillFiles.length >= maxSkills) break;
  }

  const items: SkillInventoryRecord[] = [];
  for (const file of skillFiles.slice(0, maxSkills)) {
    const realFile = realpathOrUndefined(file) ?? file;
    if (isSubpath(file, workspace.root) && !isSubpath(realFile, workspace.root)) continue;
    let text = "";
    try {
      text = await safeReadText(realFile);
    } catch {
      // Keep the skill visible even if the file cannot be read.
    }
    const name = frontmatterValue(text, "name") ?? path.basename(path.dirname(realFile));
    const description = frontmatterValue(text, "description");
    items.push({
      name,
      description,
      source: skillSource(realFile, workspace.root),
      path: displayPath(realFile, workspace.root),
      absPath: realFile
    });
  }

  return unique(items, (item) => `${item.source}:${item.name}:${item.path}`).sort(compareSkills);
}

/**
 * 发现并返回 Skill 公开清单（不含 absPath）。
 *
 * 这是对外暴露的发现接口：将内部 SkillInventoryRecord 转换为公开的
 * SkillInventoryItem，确保服务端文件系统路径（absPath）不会泄露给调用方。
 */
export async function discoverSkillInventory(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryItem[]> {
  return (await discoverSkillRecords(workspace, options)).map(publicSkill);
}

/**
 * 加载指定 Skill 的 SKILL.md 内容（load_skill 工具的实现）。
 *
 * 精确匹配逻辑：
 * - name 必须完全匹配（不做前缀或模糊匹配）
 * - source 和 path 是可选的精确过滤条件（用于同名 Skill 的消歧义）
 * - 多个同名匹配时，要求调用方提供 source 和 path 选择
 *
 * 安全限制：
 * - 只能加载 SKILL.md 文件（path.basename 检查），防止通过 Skill 加载机制
 *   读取任意 absPath 指向的文件（即使 discoverSkillRecords 发现了非预期文件）
 * - maxBytes 限制了单次加载的最大字节数（默认 40KB，最大 100KB）
 */
export async function loadSkill(
  workspace: Workspace,
  options: {
    name: string;
    source?: SkillInventoryItem["source"];
    path?: string;
    includeGlobal?: boolean;
    maxSkills?: number;
    maxBytes?: number;
  }
): Promise<LoadedSkill> {
  const name = options.name.trim();
  if (!name) throw new Error("Skill name is required.");
  const requestedPath = options.path?.trim();

  const records = await discoverSkillRecords(workspace, {
    includeGlobal: options.includeGlobal !== false,
    maxSkills: options.maxSkills
  });
  const matches = records.filter(
    (skill) =>
      skill.name === name &&
      (!options.source || skill.source === options.source) &&
      (!requestedPath || skill.path === requestedPath)
  );
  if (!matches.length) {
    const near = records
      .filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, 8)
      .map((skill) => `${skill.name} [${skill.source}]`)
      .join(", ");
    const suffix = requestedPath ? ` at ${requestedPath}` : "";
    throw new Error(`Skill not found: ${name}${suffix}${near ? `. Similar skills: ${near}` : ""}`);
  }
  if (matches.length > 1) {
    const choices = matches.map((skill) => `${skill.name} [${skill.source}] at ${skill.path}`).join("; ");
    throw new Error(`Multiple skills named ${name} were found. Pass source and path to choose one: ${choices}`);
  }

  const [skill] = matches;
  if (path.basename(skill.absPath) !== "SKILL.md") {
    throw new Error(`Refusing to load non-skill file: ${skill.path}`);
  }
  if (skill.source === "workspace") {
    const realSkillPath = realpathOrUndefined(skill.absPath);
    if (!realSkillPath || !isSubpath(realSkillPath, workspace.root)) {
      throw new Error(`Refusing to load workspace skill outside workspace: ${skill.path}`);
    }
  }
  const maxBytes = Math.max(1_000, Math.min(options.maxBytes ?? 40_000, 100_000));
  const loaded = await readTextWithStats(skill.absPath, maxBytes);
  return {
    skill: publicSkill(skill),
    text: loaded.text,
    bytes: loaded.bytes,
    totalBytes: loaded.totalBytes,
    truncated: loaded.truncated
  };
}

/**
 * 从 TOML 格式的 Codex config 中提取 MCP Server 名称列表。
 *
 * 只匹配 [mcp_servers.<name>] 或 [mcpServers.<name>] 的表头，
 * 不读取表内容（避免提取地址或凭据）。
 * 正则支持带引号的 server 名称（如 [mcp_servers."my server"]）。
 */
function parseTomlMcpServers(text: string, source: string): McpServerInventoryItem[] {
  const out: McpServerInventoryItem[] = [];
  const re = /^\s*\[(?:mcp_servers|mcpServers)\.("?)([^"\].]+)\1\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({ name: match[2], source });
  }
  return out;
}

/**
 * 从 JSON 格式的 MCP config 文件（.mcp.json、mcp.json）中提取 Server 名称列表。
 *
 * 标准格式为 { "mcpServers": { "<name>": { "command": ..., "env": ... } } }。
 * 只提取顶层键名（服务名称），不提取 command、args、env 等敏感字段。
 */
function parseJsonMcpServers(text: string, source: string): McpServerInventoryItem[] {
  try {
    const parsed = JSON.parse(text);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
    return Object.keys(servers).map((name) => ({ name, source }));
  } catch {
    return [];
  }
}

/**
 * 发现当前工作区和用户级 MCP Server 配置中的服务名称列表。
 *
 * 扫描文件（不存在时跳过）：
 * 1. ~/.codex/config.toml — Codex 的 TOML 格式配置（[mcp_servers]）
 * 2. <workspace>/.mcp.json — 工作区级 MCP JSON 配置
 * 3. <workspace>/.cursor/mcp.json — Cursor 工作区 MCP 配置
 * 4. ~/.cursor/mcp.json — Cursor 用户级 MCP 配置
 *
 * 安全设计：只提取服务名称，不暴露 command、args、env 等配置字段。
 * 即使 env 字段中含有 API Key，也不会出现在返回结果中。
 */
export async function discoverMcpServers(workspace: Workspace): Promise<McpServerInventoryItem[]> {
  const candidates = [
    { file: path.join(os.homedir(), ".codex", "config.toml"), kind: "toml", source: "user codex config" },
    { file: path.join(workspace.root, ".mcp.json"), kind: "json", source: "workspace config" },
    { file: path.join(workspace.root, ".cursor", "mcp.json"), kind: "json", source: "workspace cursor config" },
    { file: path.join(os.homedir(), ".cursor", "mcp.json"), kind: "json", source: "user cursor config" }
  ];

  const servers: McpServerInventoryItem[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) continue;
    let text = "";
    try {
      text = await safeReadText(candidate.file, 200_000);
    } catch {
      continue;
    }
    servers.push(...(candidate.kind === "toml" ? parseTomlMcpServers(text, candidate.source) : parseJsonMcpServers(text, candidate.source)));
  }

  return unique(servers, (server) => `${server.source}:${server.name}`)
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))
    .slice(0, MAX_MCP_SERVER_INVENTORY);
}

/**
 * 生成完整的 CodexPro 服务清单（codexpro_inventory 工具的实现）。
 *
 * 清单内容：
 * - 当前工作区信息（root、配置模式）
 * - Skill 统计（按来源分类：workspace/user/plugin/other）
 * - Skill 列表（名称、来源、描述）
 * - MCP Server 列表（名称、来源配置文件）
 *
 * 用途：模型可以在开始任务前调用此工具，了解当前环境的完整能力，
 * 避免因为不知道有某个 Skill 而重复造轮子。
 *
 * includeMcpServers=false 时跳过 MCP Server 发现（如在 self-test 中需要精确控制）。
 */
export async function codexproInventory(
  config: CodexProConfig,
  workspace: Workspace,
  options: { includeGlobalSkills?: boolean; includeMcpServers?: boolean; maxSkills?: number } = {}
): Promise<{
  text: string;
  skills: SkillInventoryItem[];
  mcpServers: McpServerInventoryItem[];
}> {
  const skills = await discoverSkillInventory(workspace, {
    includeGlobal: options.includeGlobalSkills !== false,
    maxSkills: options.maxSkills
  });
  const mcpServers = options.includeMcpServers === false ? [] : await discoverMcpServers(workspace);

  const bySource = skills.reduce<Record<string, number>>((acc, skill) => {
    acc[skill.source] = (acc[skill.source] ?? 0) + 1;
    return acc;
  }, {});

  const skillLines = skills.length
    ? skills.map((skill) => `- ${skill.name} [${skill.source}]${skill.description ? ` - ${skill.description}` : ""}`).join("\n")
    : "- none discovered";
  const mcpLines = mcpServers.length
    ? mcpServers.map((server) => `- ${server.name} (${server.source})`).join("\n")
    : "- none discovered";

  const text = `# CodexPro Inventory

Workspace: ${workspace.root}
Bash mode: ${config.bashMode}
Write mode: ${config.writeMode}
Tool mode: ${config.toolMode}

## Skill summary

Total: ${skills.length}
Workspace: ${bySource.workspace ?? 0}
User: ${bySource.user ?? 0}
Plugin: ${bySource.plugin ?? 0}
Other: ${bySource.other ?? 0}

${skillLines}

## MCP servers

${mcpLines}
`;

  return { text, skills, mcpServers };
}
