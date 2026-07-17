/**
 * 输出脱敏模块：防止 MCP Tool Result 泄露密钥和敏感凭据。
 *
 * MCP Server 的工具返回结果会传输给 ChatGPT 等外部客户端，并可能
 * 记录在对话历史中。任何出现在工具输出中的密钥都有被存档、转发的风险。
 *
 * 本模块在 server.ts 的 textResult() 和 errorResult() 函数中被调用，
 * 作为所有工具结果进入 MCP 协议层前的最后一道过滤屏障。
 *
 * 重要限制：
 * - 脱敏不能替代最小权限原则。正确的做法是工具本身不读取敏感文件
 *   （由 PathGuard 的 blockedGlobs 保证），脱敏只是纵深防御的最后一层。
 * - 结构化对象（structuredContent）和错误消息也需要脱敏，不只是文本。
 * - 占位符（如 process.env.OPENAI_KEY、[REDACTED_SECRET]）不会被二次脱敏，
 *   避免对源代码中的示例代码产生误报。
 *
 * 上游调用者：src/server.ts（textResult、errorResult）
 * 下游依赖：无（纯字符串处理）
 */

/** 匹配 OpenAI API Key（sk- 开头，至少 10 位字母数字字符）。 */
const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const COMMON_TOKEN_PATTERN = /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g;
const BEARER_TOKEN_PATTERN = /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const CLI_TOKEN_PATTERN = /((?:\bngrok\s+config\s+add-authtoken|\bcloudflared\s+service\s+install|--(?:token|access-token|auth-token|api[_-]?key|authtoken))(?:=|\s+))[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_TOKEN_PATTERN = /([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'`<>]{8,}/gi;
const CODEXPRO_TOKEN_ASSIGNMENT_PATTERN = /\b(codexpro_token\s*=\s*)(?:"[^"\r\n]{8,512}"|'[^'\r\n]{8,512}'|`[^`\r\n]{8,512}`|[A-Za-z0-9_./+=-]{8,512})/gi;
const CODEXPRO_TOKEN_FIELD_PATTERN = /(["']?codexpro_token["']?\s*:\s*)(?:"[^"\r\n]{8,512}"|'[^'\r\n]{8,512}'|`[^`\r\n]{8,512}`|[A-Za-z0-9_./+=-]{8,512})/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}\s*=\s*(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_FIELD_PATTERN = /(["']?[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}["']?\s*:\s*)(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_PATTERNS = [OPENAI_SECRET_PATTERN, COMMON_TOKEN_PATTERN, BEARER_TOKEN_PATTERN, CLI_TOKEN_PATTERN, QUERY_TOKEN_PATTERN, CODEXPRO_TOKEN_ASSIGNMENT_PATTERN, CODEXPRO_TOKEN_FIELD_PATTERN, SECRET_ASSIGNMENT_PATTERN, SECRET_FIELD_PATTERN];

/**
 * 检测文本中是否包含疑似真实密钥（排除已知占位符后）。
 *
 * 主要用于 writeTextFile 写入前的预检：如果即将写入文件的内容含有
 * 疑似真实密钥，则拒绝写入，要求使用占位符（如 [REDACTED_SECRET]）。
 *
 * @param text 要检查的字符串
 * @returns 含有疑似真实密钥时返回 true
 */
export function hasSecretValue(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (!isPlaceholderSecret(match[0])) return true;
    }
  }
  return false;
}

/**
 * 对文本字符串执行脱敏处理，返回脱敏后的新字符串。
 *
 * 替换规则：
 * - API_KEY="sk-xxx" → API_KEY= [REDACTED_SECRET]（保留 key 名便于调试）
 * - sk-xxx → [REDACTED_SECRET]（直接替换 token 本体）
 *
 * 文本脱敏与结构化对象脱敏的区别：
 * - 文本脱敏（本函数）：处理 Markdown 文本、错误消息、shell 输出等自由格式内容。
 * - 结构化脱敏（redactStructured）：递归处理 JSON 对象，逐字段替换字符串值。
 * 两者配合，覆盖 MCP Tool Result 的 content（文本）和 structuredContent（对象）两个路径。
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(CODEXPRO_TOKEN_ASSIGNMENT_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(CODEXPRO_TOKEN_FIELD_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(CLI_TOKEN_PATTERN, (match, prefix) => isPlaceholderSecret(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (match) => isPlaceholderSecret(match) ? match : redactSecretAssignment(match))
    .replace(SECRET_FIELD_PATTERN, (match, prefix) => isPlaceholderSecret(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(BEARER_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(QUERY_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(OPENAI_SECRET_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]")
    .replace(COMMON_TOKEN_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
}

/**
 * 递归脱敏任意结构化值（对象、数组、字符串等）。
 *
 * 用于处理 structuredContent 字段，该字段可以是任意深度的 JSON 对象。
 * 深度限制为 8 层，防止循环引用或超深对象导致的性能问题。
 *
 * @param value 要脱敏的值（任意类型）
 * @param depth 当前递归深度（内部参数，外部调用时省略）
 * @returns 脱敏后的同类型值
 */
export function redactStructured<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactStructured(item, depth + 1);
  }
  return out as T;
}

/**
 * 判断匹配到的内容是否是已知的占位符（而非真实密钥）。
 *
 * 以下情况视为占位符，不进行脱敏：
 * - 已经含有 [REDACTED_SECRET]（二次处理保护）
 * - 常见的示例占位符（replace-me、your-api-key-here、<openai_api_key>）
 * - 代码中的环境变量读取表达式（process.env.、import.meta.env.、os.environ 等）
 * - 文档中的缩写形式（sk-...）
 *
 * 这些规则确保注释中的示例代码、README、配置示例文件不会被误脱敏。
 */
function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("[redacted_secret]") ||
    normalized.includes("replace-me") ||
    normalized.includes("replace-with-long-random-token") ||
    normalized.includes("keep-this-codexpro-token-stable") ||
    normalized.includes("keep-this-stable-token") ||
    normalized.includes("your-ngrok-token") ||
    normalized.includes("your-token") ||
    normalized.includes("your-api-key-here") ||
    normalized.includes("<openai_api_key>") ||
    normalized.includes("process.env.") ||
    normalized.includes("import.meta.env.") ||
    normalized.includes("os.environ") ||
    normalized.includes("getenv(") ||
    normalized === "sk-..." ||
    normalized.endsWith("=sk-...")
  );
}

/**
 * 将赋值形式的密钥替换为脱敏版本，保留 key 名。
 *
 * 例如：API_KEY="sk-xxx" → API_KEY= [REDACTED_SECRET]
 * 保留 key 名的好处：开发者可以从脱敏后的输出中了解哪个字段含有密钥，
 * 便于诊断配置问题，同时不暴露密钥值本身。
 */
function redactSecretAssignment(value: string): string {
  const index = value.indexOf("=");
  if (index < 0) return "[REDACTED_SECRET]";
  return `${value.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
}
