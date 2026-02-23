# atom

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

默认是 `tui` 模式：同进程启动 HTTP 服务端，并启动本地 Ink TUI 客户端通过 HTTP 通讯（兼容旧名 `hybrid`）。

## 0.2.0 Breaking Changes

- `--mode repl` 已移除；当前使用 `--mode tui`（组合模式）或 `--mode tui-client`（仅客户端）
- 本地客户端命令改为 slash 命令：`/help`、`/messages`、`/context`、`/exit`
- 裸命令 `messages` / `context` / `exit` 不再保留兼容

## Project Structure

```text
src/
  index.ts                # 启动入口与模式编排
  clients/                # 客户端实现（当前为 Ink TUI）
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
  - `tui`（默认，旧名 `hybrid`）：启动 HTTP 服务端 + 本地 Ink TUI 客户端（HTTP 通讯）。
  - `server`：仅启动 HTTP 服务端。
  - `tui-client`：仅启动 Ink TUI 客户端，通过 HTTP 连接到服务端。
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

# 仅启动 Ink TUI 客户端（连接到已运行服务）
bun run src/index.ts --mode tui-client --server-url http://127.0.0.1:8787

# 指定配置文件
bun run src/index.ts --workspace ./Playground --config ./agent.config.json
```

### TUI Commands

- `/help`
- `/messages`
- `/context`
- `/exit`

### HTTP API (v1)

当前输入输出已解耦，Ink TUI 客户端通过 HTTP 与服务端通讯（轮询模式，非流式）。

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

## Tool permission config

Atom 会在启动时加载 `agent.config.json`（默认路径为 `<workspace>/agent.config.json`），用于限制 tools 的读写路径和网络访问地址。

### 规则说明

- 每个工具支持 `allow` / `deny` 两组正则。
- `deny` 优先级高于 `allow`。
- 如果未配置 `allow`，默认允许（仅受 `deny` 限制）。
- 如果配置了 `allow`，则必须命中其中至少一条才允许。
- 支持两个路径变量：`{workspace}`（当前工作目录）与 `{root}`（系统根目录），会在加载配置时自动展开为正则安全的绝对路径文本。

### 配置示例

```json
{
  "tools": {
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
    "webfetch": {
      "allow": ["^https://docs\\.example\\.com/.*"],
      "deny": ["^https?://(localhost|127\\.0\\.0\\.1)(:.*)?/.*"]
    },
    }
  }
}
```

默认配置文件位于 `<workspace>/agent.config.json`。

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
