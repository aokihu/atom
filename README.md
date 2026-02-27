# atom

Atom 是一个基于 Bun 的 Agent Runtime，支持本地 TUI 与 Telegram 客户端，并通过统一 HTTP Gateway 与运行时通信。

## 项目现状（2026-02-27）

- 当前版本：`0.11.0`
- 代码健康：`bun run typecheck` 通过
- 测试状态：`bun run test` 通过（`272` 项）
- 启动验证：使用 `Playground` 工作区，`server` 模式可正常返回 `/healthz`

## 快速开始

### 1) 安装依赖

```bash
bun install
```

### 2) 使用 Playground 作为模拟工作区启动

```bash
bun run src/index.ts --workspace=./Playground
```

默认模式为 `tui`：同进程启动 HTTP 服务端与本地 OpenTUI 客户端。

### 3) 常用命令

```bash
# 开发启动（等价于 --workspace=./Playground）
bun run dev

# 类型检查
bun run typecheck

# 测试
bun run test
```

## 运行模式

- `tui`：默认模式，HTTP 服务端 + 本地 TUI 客户端
- `server`：仅服务端
- `tui-client`：仅 TUI 客户端（连接已有服务）
- `telegram`：服务端 + Telegram 客户端
- `telegram-client`：仅 Telegram 客户端（连接已有服务）
- `hybrid`：历史别名，等价于 `tui`（已弃用）

示例：

```bash
# server-only
bun run src/index.ts --mode server --workspace ./Playground --http-port 8787

# TUI client-only
bun run src/index.ts --mode tui-client --server-url http://127.0.0.1:8787

# Telegram 组合模式
bun run src/index.ts --mode telegram --workspace ./Playground
```

## CLI 参数

- `--workspace <path>`：工作区目录（默认 `process.cwd()`）
- `--config <path>`：配置文件路径（默认 `<workspace>/agent.config.json`）
- `--mode <tui|server|tui-client|telegram|telegram-client>`
- `--http-host <host>`：服务监听地址（默认 `127.0.0.1`）
- `--http-port <port>`：服务监听端口（默认 `8787`）
- `--server-url <url>`：client-only 模式连接地址（优先于 `--http-host/--http-port`）

## HTTP API（v1）

- `GET /healthz`
- `POST /v1/tasks`
- `GET /v1/tasks/:id`
- `GET /v1/agent/context`
- `GET /v1/agent/messages`
- `POST /v1/agent/memory/search`
- `POST /v1/agent/memory/get`
- `POST /v1/agent/memory/upsert`
- `POST /v1/agent/memory/update`
- `POST /v1/agent/memory/delete`
- `POST /v1/agent/memory/feedback`
- `POST /v1/agent/memory/tag_resolve`
- `GET /v1/agent/memory/stats`
- `POST /v1/agent/memory/compact`
- `POST /v1/agent/memory/list_recent`

响应结构统一：

- 成功：`{"ok": true, "data": ...}`
- 失败：`{"ok": false, "error": {"code": "...", "message": "..."}}`

## 内置工具与权限

当前内置工具：

- `ls` `read` `tree` `ripgrep` `write`
- `todo_list` `todo_add` `todo_update` `todo_complete` `todo_reopen` `todo_remove` `todo_clear_done`
- `memory_write` `memory_search` `memory_get` `memory_update` `memory_delete` `memory_feedback` `memory_tag_resolve` `memory_compact` `memory_list_recent`
- `cp` `mv` `git` `bash` `background` `webfetch`

`agent.config.json` 的 `permissions` 段可对工具设置 `allow` / `deny` 正则规则，且 `deny` 优先级高于 `allow`。

## 持久化记忆（标签化冷记忆）

- context 协议升级到 `3.0`，支持 `memory.longterm`。
- 持久化记忆支持两种内容状态：
  - `active`：正文常驻
  - `tag_ref`：保留 `tag_id + tag_summary` 占位，正文转入冷存储
- 当记忆低活跃但仍有较高复用概率时，系统会优先标签化而不是直接删除；后续可通过 `memory_tag_resolve` 恢复。
- 新工作区模板默认开启 `memory.persistent.enabled = true`。

## 任务意图护栏（Browser-first）

- `agent.execution.intentGuard` 默认开启。
- 当任务明确要求“使用浏览器访问”时：
  - 优先要求浏览器能力工具（如 browser/playwright 类 MCP 工具）
  - 仅允许有限次数的网络邻近工具偏航（默认 2 次），超过后拦截
  - 若最终没有任何浏览器能力工具成功执行，任务标记为 `intent_execution_failed`
- 关键开关位于 `agent.execution.intentGuard`：
  - `enabled`
  - `detector` (`model` / `heuristic`)
  - `softBlockAfter`
  - `browser.noFallback` / `browser.networkAdjacentOnly` / `browser.failTaskIfUnmet`

## 配置说明（agent.config.json）

关键字段：

- `agent.name`：Agent 名称（影响 TUI 展示与 `/healthz.name`）
- `agent.model`：格式 `"<provider_id>/<model>"`
- `agent.params`：模型推理参数（如 `temperature`、`topP`、`maxOutputTokens`）
- `agent.execution`：运行预算（如 `maxToolCallsPerTask`、`maxModelStepsPerTask`）
- `providers[]`：模型供应商配置（`provider_id`、`model`、可选 `api_key`/`api_key_env`、可选 `base_url`/`headers`）
- `mcp.servers[]`：MCP 服务（`http` 或 `stdio`）
- `telegram`：Telegram Bot 配置（仅 telegram 模式需要）

支持的 `provider_id`：

- 原生：`deepseek`、`openrouter`
- OpenAI-compatible：`volcengine`、`openai`、`siliconflow`、`moonshot`、`dashscope`、`groq`、`together`、`xai`、`ollama`、`openai-compatible`

## TUI 命令

- `/help`
- `/messages`
- `/context`
- `/exit`

## 目录结构

```text
src/
  index.ts                # 入口与模式编排
  clients/                # TUI / Telegram 客户端
  libs/
    agent/                # Agent 核心与工具编排
    channel/              # Gateway 契约与 HTTP 实现
    runtime/              # 任务运行时与队列
    mcp/                  # MCP 初始化与集成
    utils/                # CLI / workspace 等工具
  prompts/                # Prompt 模板
  templates/              # 工作区模板
  types/                  # 共享类型
Playground/               # 本地模拟运行工作区
docs/
  ARCHITECTURE.md         # 架构边界文档
  IMPROVEMENTS.md         # 改良清单与优化进展
```

## v0.11.0 更新

- 全面更新 README，使其与 `0.10.x` 的实际实现一致。
- 新增改良文档 `docs/IMPROVEMENTS.md`，沉淀现状分析、优先级与执行建议。
- 优化 `workspace_check`：改为并行且幂等的工作区初始化流程，减少启动阶段文件系统往返。
- 新增 `workspace_check` 测试，确保初始化与“不覆盖已有文件”行为稳定。
- 持久化记忆模块在启用时会自动创建 `{workspace}/.agent`，避免新工作区下初始化即降级为 unavailable。

## 安全建议

- 不要将真实 `api_key`、`botToken`、`webhookSecretToken` 提交到仓库。
- 建议在本地或 CI 中通过环境变量注入敏感信息。

## 文档

- 架构文档：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- 改良计划：[docs/IMPROVEMENTS.md](./docs/IMPROVEMENTS.md)
