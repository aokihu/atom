# Atom Architecture

本文档描述当前项目的模块边界、职责划分和扩展建议，目标是让后续开发（新客户端、新传输协议、新运行时能力）可以在不破坏现有结构的前提下推进。

## 目录结构（当前建议）

```text
src/
  index.ts                # 进程入口与模式编排（tui/server/tui-client/telegram/telegram-client）
  clients/                # 用户侧客户端实现（OpenTUI TUI / Telegram，后续 web/bot）
  libs/
    agent/                # Agent 核心逻辑、提示词注入、工具集成
    channel/              # 通信通道契约与 HTTP 实现（gateway/client）
    runtime/              # 任务运行时（队列、任务注册、调度）
    mcp/                  # MCP 初始化与工具接入
    utils/                # CLI、日期、workspace 检查等基础工具
  prompts/                # 系统提示词模板
  templates/              # 初始化工作区模板文件
  types/                  # 跨模块共享类型（task/http/agent）
docs/
  ARCHITECTURE.md         # 架构与开发边界说明（本文件）
```

## 模块边界（必须遵守）

### `src/clients`
- 放置“用户交互端”实现，例如：
  - `tui`（OpenTUI）
  - `telegram`（Bot adapter，基于 `GatewayClient`）
  - 后续 Web UI / 其他 Bot adapter
- 只通过 `GatewayClient`（或其他通道抽象）访问服务端。
- 不直接依赖 `Agent`、`PriorityTaskQueue`、`AgentRuntimeService`。

#### `src/clients/tui`（0.5.0 重构后）

当前 OpenTUI 客户端已按职责拆分，避免单文件膨胀：

- `runtime/`
  - `state.ts`: TUI 客户端状态模型（连接状态、焦点、消息、弹窗状态等）
  - `ui.ts`: OpenTUI 组件树装配（bundle）与挂载/卸载
- `views/`
  - 消息面板、输入面板、状态栏、slash modal、context modal 的视图构建函数
  - 目标是“尽量纯视图”，不直接处理业务流程
- `controllers/`
  - slash 命令解析与交互控制（如 `/context` / `/exit`）
- `flows/`
  - 提交任务、轮询任务状态等流程编排
- `layout/`
  - 终端尺寸读取与布局参数计算
- `state/`
  - UI 层的静态状态定义（如 slash 命令列表）
- `theme/` / `utils/`
  - 主题和文本处理等辅助逻辑

建议约束：
- `views/` 不直接调用 `GatewayClient`
- `controllers/` 只返回动作或协调状态，不直接创建网络层实例
- 与服务端交互集中在 `flows/`（或后续抽出的 data/service 层）

#### `src/clients/telegram`

- Telegram Bot 客户端同样只通过 `GatewayClient` 与 runtime 通信。
- 核心职责拆分：
  - `bot_api.ts`: Telegram Bot API 封装（`getUpdates` / `sendMessage`）
  - `polling.ts`: long polling 循环、offset 管理、异常退避
  - `dispatcher.ts`: 白名单校验、命令分发、任务触发与最终结果回传
  - `markdown_v2.ts` / `message_split.ts`: 消息格式与分片处理
- 本轮仅支持 polling；webhook 配置已预留，服务端路由尚未实现。

### `src/libs/channel`
- 定义通道契约与传输实现。
- 当前包含：
  - `channel.ts`: 契约接口（`GatewayClient` / `RuntimeGateway`）
  - `http_gateway.ts`: 服务端 HTTP 网关
  - `http_client.ts`: 客户端 HTTP 调用封装
- 当增加新协议（如 SSE/WebSocket/gRPC）时，优先扩展这里而不是改客户端业务逻辑。

当前 HTTP 网关特性（补充）：
- `/healthz` 返回 `name/version/startupAt/queue`
- 统一响应结构：`{ ok: true, data }` / `{ ok: false, error }`
- `POST /v1/tasks` 支持请求体校验（`input` 必填，`priority` 范围 `0..4`，`type` 可选）

### `src/libs/runtime`
- 负责任务执行编排，不负责 I/O 展示。
- 当前包含：
  - `service.ts`: `AgentRuntimeService`（Agent + Queue + TaskRegistry）
  - `queue/`: 队列实现与 `createTask`
- 运行时能力（限流、取消、持久化队列、任务 TTL）应优先放在这里。

### `src/libs/agent`
- 负责模型调用、上下文注入、工具执行集成。
- 不处理 HTTP 或客户端等传输/交互细节。

### `src/types`
- 存放跨层类型：
  - `task.ts`：运行时任务模型
  - `http.ts`：HTTP DTO / API 响应体
  - `agent.ts`：Agent 配置与上下文类型
- 如果类型只在单个模块内部使用，优先留在模块内，避免 `types` 目录膨胀。

## 依赖方向（推荐）

```text
clients -> libs/channel -> libs/runtime -> libs/agent
                      \-> types
index.ts 负责装配（composition root）
```

约束：
- `clients` 不反向引用 `runtime/agent`
- `agent` 不引用 `channel/clients`
- `index.ts` 做组装，不写具体业务协议逻辑（可继续拆分，但不在本次）

## 扩展指南

### 新增客户端（例如 Web/TUI）
1. 在 `src/clients/` 新增客户端实现文件。
2. 只依赖 `GatewayClient`（可直接复用 `HttpGatewayClient`）。
3. 把启动逻辑挂到 `src/index.ts` 的 mode 编排，或新增单独入口。

### 新增通信协议（例如 SSE）
1. 在 `src/libs/channel/` 新增 `sse_gateway.ts` 或扩展 `http_gateway.ts`。
2. 在 `src/types/http.ts`（或新增协议专属类型文件）定义 DTO。
3. 保持 `RuntimeGateway` 契约稳定，避免让客户端感知运行时实现细节。

### 新增任务运行时能力（例如取消任务）
1. 先扩展 `src/types/task.ts` 语义（状态、字段、返回码）。
2. 在 `src/libs/runtime/service.ts` 实现 registry/queue 协调。
3. 最后暴露到 `src/libs/channel/http_gateway.ts` 的 API。

## 文档维护建议

- `README.md` 保持“快速开始 + 常用命令 + API 概览”。
- 复杂设计说明放 `docs/`，避免 README 膨胀。
- 涉及公共接口（CLI 参数、HTTP API、DTO）变更时，必须同步更新：
  - `README.md`
  - `src/types/*.ts`
  - `docs/ARCHITECTURE.md`（若边界/职责变化）

## 当前已知技术债

- HTTP API 当前为轮询模式，未实现流式输出与鉴权。
- OpenTUI 客户端主入口（`src/clients/tui/index.ts`）仍偏大，后续可继续拆分输入处理、渲染同步与轮询状态机。
