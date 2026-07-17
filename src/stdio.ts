#!/usr/bin/env node
/**
 * stdio Transport 启动入口：将 CodexPro MCP Server 连接到标准输入输出流。
 *
 * stdio Transport 是 MCP 协议的两种主要传输方式之一：
 *
 * 1. stdio Transport（本文件）：
 *    - 客户端通过 stdin/stdout 与 MCP Server 通信
 *    - 本地进程间通信，无网络暴露
 *    - 适合 Claude Desktop、本地 Codex CLI、IDE 插件等本地客户端
 *    - 安全性最高：无网络监听，无认证需求，天然隔离
 *    - 以此方式启动时，一个进程只服务一个客户端
 *
 * 2. HTTP Transport（src/http.ts）：
 *    - 通过 SSE（Server-Sent Events）与 HTTP POST 提供 MCP over HTTP/1.1
 *    - 适合 ChatGPT Connector、远程 AI 应用等网络客户端
 *    - 需要认证（requireHttpToken）和可选的隧道（cloudflared）
 *    - 可同时服务多个客户端会话
 *
 * MCP 协议消息格式：JSON-RPC 2.0，通过 \n 换行分隔，通过 stdin/stdout 传输。
 * @modelcontextprotocol/sdk 的 StdioServerTransport 封装了所有协议细节。
 *
 * 启动流程：
 * 1. loadConfig()：从命令行参数和环境变量构建运行时配置
 * 2. createCodexProServer()：构建 MCP Server 实例（注册所有工具和资源）
 * 3. new StdioServerTransport()：创建 stdio 传输层
 * 4. server.connect(transport)：启动 JSON-RPC 消息循环
 *    进程在 stdin 关闭（客户端断开）前持续运行
 *
 * 错误处理：
 * - 启动失败时打印错误（stack trace 优先）并以 exit(1) 退出
 * - 连接建立后的协议错误由 SDK 内部处理，通过 JSON-RPC 错误响应返回
 *
 * 上游：codexpro.mjs 启动脚本（通过 spawn 或 exec 调用）
 * 下游：src/config.ts（loadConfig）、src/server.ts（createCodexProServer）
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createCodexProServer } from "./server.js";

const CODEXPRO_VERSION = "0.29.0";

function printHelp(): void {
  console.log(`CodexPro MCP stdio server

Usage:
  codexpro-mcp --root /path/to/repo [--allow-root /path]
  codexpro-mcp --version
  codexpro-mcp --help

Most users should run: codexpro start`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN ??= "1";
  const config = loadConfig();
  const server = createCodexProServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
