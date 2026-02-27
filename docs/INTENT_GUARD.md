# Intent Guard（通用意图策略引擎）设计与运维说明

本文档说明 Agent 的意图检测与工具作用域护栏模块。目标是把“任务意图 -> 工具行为约束”从单一浏览器场景扩展为可配置的通用策略引擎。

## 1. 模块目标

- 基于任务意图执行工具调用约束，避免执行偏航。
- 让失败路径显式化（可观测、可复现、可回归）。
- 支持按意图配置策略，不把规则硬编码在单一场景里。

## 2. 代码位置

- 核心实现：
  - `src/libs/agent/core/intent_guard.ts`
- Runner 集成（preflight / completion / stop reason）：
  - `src/libs/agent/core/agent_runner.ts`
- 工具执行拦截点：
  - `src/libs/agent/tools/registry.ts`
- 停止原因定义：
  - `src/types/task.ts`
- 配置与默认值：
  - `src/types/agent.ts`
  - `src/libs/agent/config/validator.ts`
  - `src/templates/agent.config.json`

## 3. 意图与工具族模型

### 3.1 支持的意图

- `general`
- `browser_access`
- `network_research`
- `filesystem_ops`
- `code_edit`
- `memory_ops`

说明：

- 默认仅启用 `browser_access` 的约束策略。
- 其他意图默认关闭，可按需在配置中开启。

### 3.2 工具族分类

- `browser`
- `network`
- `filesystem`
- `memory`
- `vcs`
- `task`
- `shell`
- `unknown`

工具名会被归类到上述工具族，然后由意图策略决定允许/拦截。

## 4. 检测流程

### 4.1 Heuristic 优先

`detectHeuristicIntent` 先走关键短语检测（浏览器、记忆、代码改动、文件操作、网络检索）。

### 4.2 Model 判定（可选）

当 `intentGuard.detector = "model"` 时，调用模型返回 JSON：

```json
{"label":"general|browser_access|network_research|filesystem_ops|code_edit|memory_ops","confidence":0..1,"reason":"short"}
```

若模型输出不可解析，则回退到 heuristic 结果。

## 5. 策略结构

配置路径：`agent.execution.intentGuard.intents.<intent>`

每个意图策略支持：

- `enabled`
- `allowedFamilies`
- `softAllowedFamilies`
- `softBlockAfter`
- `noFallback`
- `failTaskIfUnmet`
- `requiredSuccessFamilies`

语义：

- `allowedFamilies`: 直接允许的工具族
- `softAllowedFamilies`: 允许有限偏航（受 `softBlockAfter` 限制）
- `requiredSuccessFamilies`: 任务完成前必须至少成功命中一个的工具族
- `noFallback`: 若关键工具族不可用，任务开始前直接失败
- `failTaskIfUnmet`: 若完成前仍未满足 `requiredSuccessFamilies`，任务失败

## 6. 执行时序

### 6.1 Preflight

任务开始前检查：

- 若意图策略启用且 `noFallback = true`
- 且 required/allowed 关键工具族在当前运行环境不可用

则直接返回 `intent_execution_failed`。

### 6.2 Before Tool Execution

每次工具调用前：

- 工具族在 `allowedFamilies`：允许
- 工具族在 `softAllowedFamilies`：在阈值内允许，超过阈值拦截
- 其他工具族：拦截

拦截返回 `tool_policy_blocked`。

### 6.3 On Tool Settled

工具成功后，若其工具族属于 `requiredSuccessFamilies`，记录成功命中。

### 6.4 Completion Check

任务收敛前：

- 若 `failTaskIfUnmet = true`
- 且 `requiredSuccessFamilies` 无任何成功命中

返回 `intent_execution_failed`。

## 7. 受控停止原因

- `tool_policy_blocked`
  - 工具调用被当前意图策略阻断。
- `intent_execution_failed`
  - 意图关键条件未满足（preflight 不可达或 completion 未达成）。

## 8. 配置示例（推荐）

```json
{
  "intentGuard": {
    "enabled": true,
    "detector": "model",
    "softBlockAfter": 2,
    "intents": {
      "browser_access": {
        "enabled": true,
        "allowedFamilies": ["browser"],
        "softAllowedFamilies": ["network"],
        "softBlockAfter": 2,
        "noFallback": true,
        "failTaskIfUnmet": true,
        "requiredSuccessFamilies": ["browser"]
      },
      "code_edit": {
        "enabled": false,
        "allowedFamilies": ["filesystem", "vcs"],
        "softAllowedFamilies": ["shell"],
        "softBlockAfter": 1,
        "noFallback": false,
        "failTaskIfUnmet": false,
        "requiredSuccessFamilies": []
      }
    }
  }
}
```

## 9. 兼容策略

- 旧版 `intentGuard.browser.*` 仍可配置。
- 运行时会自动映射到 `intents.browser_access`，确保升级不破坏旧配置。

## 10. 观测与排障

建议关注：

- 任务消息流中的 `tool.call` / `tool.result`
- `metadata.execution.stopReason`
- 拦截文案（提示触发了哪个意图、哪个工具族）

常见排障：

1. 一直 `intent_execution_failed`
   - 检查目标意图的 `requiredSuccessFamilies` 是否可用。
   - 检查 `noFallback` 是否设置为过严。
2. 频繁 `tool_policy_blocked`
   - 检查 `allowedFamilies` / `softAllowedFamilies` 是否与任务目标一致。
   - 检查 `softBlockAfter` 是否过低。

## 11. 测试建议

### 11.1 单测

```bash
bun test src/libs/agent/core/intent_guard.test.ts
bun test src/libs/agent/core/agent_runner.test.ts
bun test src/libs/agent/tools/registry.test.ts
bun test src/libs/agent/config/config.test.ts
```

### 11.2 集成回归

```bash
bun run test:server-chat
```

### 11.3 关键场景清单

1. `browser_access` + 有 browser 工具：成功完成。
2. `browser_access` + 无 browser 工具（`noFallback=true`）：preflight 失败。
3. soft 族偏航超阈值：触发 `tool_policy_blocked`。
4. `requiredSuccessFamilies` 未命中：completion 触发 `intent_execution_failed`。
5. 旧版 `browser.*` 配置仍生效（兼容验证）。
