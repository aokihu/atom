# atom

## What's New (v0.6.0)

- AI 供应商配置迁移到 `agent.config.json`：不再使用 `.env` 的 `AI_PROVIDER / AI_MODEL / AI_API_KEY`。
- `agent.config.json` 新增 `providers` 数组，支持多供应商配置与切换（当前已内置 `deepseek`、`openrouter` 及多种 OpenAI-compatible 供应商别名）。
- 顶层 `agentName` 升级为 `agent: { name, model, params }`，其中 `agent.params` 支持 `temperature`、`topP`、`maxOutputTokens` 等常用推理参数。
- 启动日志新增模型信息展示：显示当前 `provider`、`model`，OpenAI-compatible 模型额外显示 `base_url`。
- TUI 任务失败时会在聊天区显示错误信息，避免界面看起来“没有 assistant 输出”。
- `temperature` 配置增加基础校验范围（`0 <= temperature <= 2`）。
- 重构 OpenTUI 客户端代码：按 `runtime / views / controllers / flows / layout / state / theme / utils` 分层，便于维护和扩展。
- 保持输入输出解耦：默认 `tui` 模式仍然是「本地 TUI + 同进程 HTTP 服务端」组合，通过 HTTP 通讯。
- 新增内置工具权限配置项：`cp` / `mv` / `git`（可在 `agent.config.json` 中独立配置 `allow` / `deny`）。
- `agent.name` 配置生效范围扩展：影响 TUI 展示与 `/healthz` 返回的 `name` 字段。
- `agent.config.json` 顶层权限配置字段由 `tools` 更名为 `permissions`。

## Documentation

- 架构与模块边界：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts --workspace=./Playground
```

默认是 `tui` 模式：同进程启动 HTTP 服务端，并启动本地 OpenTUI TUI 客户端通过 HTTP 通讯（兼容旧名 `hybrid`）。

## 0.6.0 Upgrade Notes

- 配置迁移（Breaking）：AI 配置从 `.env` 迁移到 `agent.config.json`。
- 配置迁移（Breaking）：顶层 `agentName` 已废弃，改为 `agent.name`。
- 配置迁移（Breaking）：模型引用改为 `agent.model = "{provider_id}/{model}"`，并通过 `providers[]` 提供对应 `api_key` / `base_url` 等信息。
- 启动时会打印 `[model] ...` 和（若存在）`[model.params] ...` 以便确认实际生效配置。
- 若 TUI 对话区没有 assistant 文本，请查看聊天区新增的 `Task failed: ...` 系统消息（现在会显示运行错误详情）。

## 0.2.0 Breaking Changes

- `--mode repl` 已移除；当前使用 `--mode tui`（组合模式）或 `--mode tui-client`（仅客户端）
- 本地客户端命令改为 slash 命令：`/help`、`/messages`、`/context`、`/exit`
- 裸命令 `messages` / `context` / `exit` 不再保留兼容

## Project Structure

```text
src/
  index.ts                # 启动入口与模式编排
  clients/                # 客户端实现（当前为 OpenTUI TUI）
  libs/
    agent/                # Agent 核心与工具
    channel/              # 通道契约与 HTTP 网关/客户端
    runtime/              # 任务运行时与队列
    mcp/                  # MCP 初始化
    utils/                # CLI/日期/workspace 等工具
  prompts/                # Prompt 模板
  templates/              # 工作区模板
  types/                  # 共享类型定义
docs/
  ARCHITECTURE.md         # 架构设计与扩展约定
```

结构约定：

- `clients` 只通过 `libs/channel` 通信，不直接操作 `Agent` 或队列。
- `libs/runtime` 负责任务编排，不负责 UI/交互。
- `src/index.ts` 作为 composition root，只负责装配模块和启动模式。

### Startup arguments

- `--workspace <path>` / `--workspace=<path>`
  - 工作目录，默认是启动时的当前目录（`process.cwd()`）。
  - 启动时会从 `<workspace>/AGENT.md` 加载提示词。
- `--config <path>` / `--config=<path>`
  - 指定配置文件路径，可选。
  - 未传时默认读取 `<workspace>/agent.config.json`。
- `--mode <tui|server|tui-client>`
  - `tui`（默认，旧名 `hybrid`）：启动 HTTP 服务端 + 本地 OpenTUI TUI 客户端（HTTP 通讯）。
  - `server`：仅启动 HTTP 服务端。
  - `tui-client`：仅启动 OpenTUI TUI 客户端，通过 HTTP 连接到服务端。
- `--http-host <host>`
  - HTTP 服务监听地址，默认 `127.0.0.1`（仅本机访问）。
- `--http-port <port>`
  - HTTP 服务监听端口，默认 `8787`。
- `--server-url <url>`
  - `tui-client` 模式连接的服务端地址（优先级高于 `--http-host/--http-port`）。

示例：

```bash
# 默认 tui 模式（推荐，兼容旧参数名 hybrid）
bun run src/index.ts --workspace ./Playground

# 仅启动 HTTP 服务端
bun run src/index.ts --mode server --workspace ./Playground --http-port 8787

# 仅启动 OpenTUI TUI 客户端（连接到已运行服务）
bun run src/index.ts --mode tui-client --server-url http://127.0.0.1:8787

# 指定配置文件
bun run src/index.ts --workspace ./Playground --config ./agent.config.json
```

### TUI Commands

- `/help`
- `/messages`
- `/context`
- `/exit`

说明（当前 `0.5.0` TUI 行为）：

- `/context`：打开上下文弹窗（context modal）。
- `/exit`：退出 TUI。
- `/help`、`/messages`：在当前会话布局中已隐藏（输入后会提示 hidden，不再弹出旧面板）。
- `Tab`：在输入区与回答区之间切换焦点（忙碌状态下会优先聚焦回答区）。

### HTTP API (v1)

当前输入输出已解耦，OpenTUI TUI 客户端通过 HTTP 与服务端通讯（轮询模式，非流式）。

- `GET /healthz`
- `POST /v1/tasks`
- `GET /v1/tasks/:id`
- `GET /v1/agent/context`
- `GET /v1/agent/messages`

#### 提交任务并轮询

```bash
# 1) 创建任务
curl -s -X POST http://127.0.0.1:8787/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"input":"你好","type":"curl.input"}'

# 2) 查询任务状态（将 <taskId> 替换为上一步返回值）
curl -s http://127.0.0.1:8787/v1/tasks/<taskId>
```

#### 返回格式

- 成功：`{"ok": true, "data": ...}`
- 失败：`{"ok": false, "error": {"code": "...", "message": "..."}}`

`GET /healthz` 补充：

- 返回 `name`（Agent 显示名）、`version`、`startupAt` 和 `queue`（运行时队列统计）。

## Tool permission config

Atom 会在启动时加载 `agent.config.json`（默认路径为 `<workspace>/agent.config.json`），用于配置 Agent 显示信息、AI 供应商以及内置工具权限。`agent.name` 会影响 TUI 和 `/healthz.name`。AI 配置已从 `.env` 的 `AI_PROVIDER / AI_MODEL / AI_API_KEY` 迁移到 `agent.config.json` 的 `agent` 与 `providers` 字段。

### AI provider 配置

- `agent.model` 使用 `"{provider_id}/{model}"` 格式，例如 `deepseek/deepseek-chat`。
- `agent.params` 可配置常用推理参数（如 `temperature`、`topP`、`topK`、`maxOutputTokens`、`presencePenalty`、`frequencyPenalty`、`stopSequences`、`seed`）。
  - 当前内置校验：`temperature` 范围为 `0 ~ 2`，`topP` 范围为 `(0, 1]`。
- `providers` 为供应商数组，配置结构按多供应商扩展设计。
- 当前运行时支持的 `provider_id`：
  - 原生：`deepseek`、`openrouter`
  - OpenAI-compatible（内置默认 `base_url`）：`openai`、`siliconflow`、`moonshot`、`dashscope`、`groq`、`together`、`xai`、`ollama`
  - 通用：`openai-compatible`（需要显式配置 `providers[].base_url`）
- `providers[].api_key` 为明文配置，请避免提交真实密钥到仓库。

常用模型示例（以供应商控制台最新可用列表为准）：

- `deepseek/deepseek-chat`
- `deepseek/deepseek-reasoner`
- `openrouter/openai/gpt-4o-mini`
- `openrouter/anthropic/claude-3.7-sonnet`
- `openai/gpt-4o-mini`
- `openai/gpt-4.1-mini`
- `siliconflow/Qwen/Qwen2.5-72B-Instruct`
- `siliconflow/deepseek-ai/DeepSeek-V3`
- `moonshot/moonshot-v1-8k`
- `dashscope/qwen-plus`
- `groq/llama-3.1-70b-versatile`
- `ollama/qwen2.5:7b`

### 规则说明

- 每个工具支持 `allow` / `deny` 两组正则。
- 新增内置工具 `cp` / `mv` / `git` 支持独立权限配置。
- `deny` 优先级高于 `allow`。
- 如果未配置 `allow`，默认允许（仅受 `deny` 限制）。
- 如果配置了 `allow`，则必须命中其中至少一条才允许。
- 支持两个路径变量：`{workspace}`（当前工作目录）与 `{root}`（系统根目录），会在加载配置时自动展开为正则安全的绝对路径文本。

### 配置示例

```json
{
  "agent": {
    "name": "MyAgent",
    "model": "deepseek/deepseek-chat",
    "params": {
      "temperature": 0.2,
      "maxOutputTokens": 4096
    }
  },
  "providers": [
    {
      "provider_id": "deepseek",
      "model": "deepseek-chat",
      "api_key": "YOUR_DEEPSEEK_API_KEY",
      "enabled": true
    }
  ],
  "permissions": {
    "read": {
      "allow": ["^{workspace}/src/.*", "^{workspace}/.*\\.md$"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "ls": {
      "allow": ["^{workspace}/.*"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "tree": {
      "allow": ["^{workspace}/.*"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "ripgrep": {
      "allow": ["^{workspace}/src/.*", "^{workspace}/.*\\.md$"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "write": {
      "allow": ["^{workspace}/Playground/.*"],
      "deny": ["^{workspace}/src/.*"]
    },
    "cp": {
      "allow": ["^{workspace}/.*"],
      "deny": []
    },
    "mv": {
      "allow": ["^{workspace}/.*"],
      "deny": []
    },
    "git": {
      "allow": ["^{workspace}/.*"],
      "deny": []
    },
    "webfetch": {
      "allow": ["^https://docs\\.example\\.com/.*"],
      "deny": ["^https?://(localhost|127\\.0\\.0\\.1)(:.*)?/.*"]
    }
  }
}
```

默认配置文件位于 `<workspace>/agent.config.json`。

补充说明：
- `cp` / `mv` 工具默认不覆盖目标文件，需显式传入 `overwrite: true`。
- `git` 工具在执行时会检查运行环境是否安装 `git`；若未安装会返回错误，而不会在启动阶段失败。

## TUI Implementation Notes (for contributors)

`0.5.0` 起 OpenTUI 客户端已做结构化拆分，主要目录如下：

- `src/clients/tui/runtime/`: UI 组件树装配与客户端状态管理
- `src/clients/tui/views/`: 纯视图构建（消息区、输入区、状态栏、弹窗）
- `src/clients/tui/controllers/`: slash 命令与交互控制逻辑
- `src/clients/tui/flows/`: 任务提交/轮询等流程编排
- `src/clients/tui/layout/`: 终端尺寸与布局计算
- `src/clients/tui/state/`: TUI 层状态模型与命令列表
- `src/clients/tui/theme/`: 主题色定义（当前 Nord）

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
