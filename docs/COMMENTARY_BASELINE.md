# Commentary Baseline

记录本次教学型源码注释改造任务开始前的项目状态。

## Environment

- Node: v22.22.3
- npm: 通过 Hermes 托管（/Users/vickers/.hermes/node 路径），沙盒环境下需 BypassSandbox=true 调用
- TypeScript: ^5.8.3（package.json devDependency）
- codexpro 版本: 0.28.5

## Git status（任务开始时）

```text
 M config.example.env
 M scripts/codexpro.mjs
?? CodexPro.command
```

### 用户已有未提交修改（受保护文件）

| 文件 | 状态 | 说明 |
|------|------|------|
| `config.example.env` | M（已修改） | 新增了 CODEXPRO_BIND_HOST / CODEXPRO_HEALTH_HOST / CODEXPRO_EXTERNAL_TUNNEL 配置注释 |
| `scripts/codexpro.mjs` | M（已修改） | 添加了 interactive 检测、runControlPanel 非 TTY 子进程等待逻辑、health host 修复 |
| `CodexPro.command` | ??（新增未追踪） | 用户自建的启动脚本 |

**这三个文件在整个任务期间不得触碰。**

## Validation（基线）

- `npm run build`: ✅ **成功**（`tsc -p tsconfig.json` 零错误）
- `npm run smoke`: ❌ **失败（已有失败，非本次引入）**

### Smoke 失败详情

```text
Error: git_diff include_diff=false hid non-git diagnostics
  at file://.../scripts/smoke.mjs:590:9
```

**失败原因分析：** `smoke.mjs` 第 590 行断言 `git_diff` 在 `include_diff=false` 时不应返回包含 non-git 诊断信息的 payload。这是 smoke 脚本对返回格式的特定期望，与外部环境相关，并非构建问题。本次注释改造不修改 smoke 测试，也不修改业务逻辑，故此失败将保持原状。

## Existing failures

- `npm run smoke` 的 `git_diff include_diff=false hid non-git diagnostics` 断言失败（已有，非本次引入）

## Source files to be annotated

| 文件 | 大小 | Phase | 优先级 |
|------|------|-------|--------|
| `src/stdio.ts` | 537 B | Phase 6.1 | 高（入口点） |
| `src/guard.ts` | 6.3 KB | Phase 1.1 | 高（安全边界） |
| `src/redact.ts` | 2.1 KB | Phase 1.2 | 高（脱敏） |
| `src/config.ts` | 10.5 KB | Phase 1.3 | 高（配置） |
| `src/profileStore.ts` | 4.4 KB | Phase 1.4 | 中（持久化） |
| `src/fsOps.ts` | 13.9 KB | Phase 2.1 | 高（文件操作） |
| `src/searchOps.ts` | 5.7 KB | Phase 2.2 | 中（搜索） |
| `src/gitOps.ts` | 2.1 KB | Phase 2.3 | 中（Git） |
| `src/bashOps.ts` | 8.0 KB | Phase 2.4 | 高（Bash 安全） |
| `src/workspaceOps.ts` | 10.3 KB | Phase 2.5 | 高（工作区） |
| `src/capabilitiesOps.ts` | 11.3 KB | Phase 3.1 | 中（能力发现） |
| `src/codexSessions.ts` | 15.0 KB | Phase 3.2 | 中（会话读取） |
| `src/proContext.ts` | 10.9 KB | Phase 3.3 | 中（Pro 上下文） |
| `src/toolCardWidget.ts` | 37.6 KB | Phase 4 | 高（UI Widget） |
| `src/server.ts` | 76.5 KB | Phase 5 | 最高（注册中心） |
| `src/http.ts` | 61.2 KB | Phase 6.2 | 高（HTTP Transport） |

## 注释原则承诺

- 只修改注释、文档字符串和教学文档
- 不修改业务逻辑
- 不触碰受保护文件
- 每个 Phase 完成后执行 `npm run build` 验证
- 发现 Bug 记录到 `docs/COMMENTARY_FINDINGS.md`，不修复
