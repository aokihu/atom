# Intent Guard (Browser-first) 设计与运维说明

本文档说明 Agent 的意图检测与工具作用域护栏模块，目标是避免任务执行偏航，并把失败以可观测、可重试、可回归的方式暴露出来。

## 1. 模块目标

- 对明确要求“浏览器访问”的任务执行 Browser-first 策略。
- 避免模型把浏览器任务退化成文件系统或无关工具调用。
- 在能力不足或执行偏航时返回受控失败，而不是“看起来成功”。

## 2. 代码位置

- 意图检测与护栏核心：
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

## 3. 当前意图模型

当前只支持两类意图：

- `browser_access`
- `general`

说明：

- `general` 不施加 Browser-first 限制。
- `browser_access` 执行专门的工具作用域约束和完成性校验。

## 4. 检测流程

### 4.1 Heuristic 优先

`detectHeuristicIntent` 先检查关键词/正则（例如“用浏览器”“浏览器访问”“open in browser”）。

- 命中后直接判定 `browser_access`（高置信度）。
- 未命中时进入下一步（取决于配置）。

### 4.2 Model 判定（可选）

当 `intentGuard.detector = "model"` 时，调用模型返回 JSON：

```json
{"label":"browser_access|general","confidence":0..1,"reason":"short"}
```

若模型输出不可解析，则回退 heuristic 结果。

## 5. 工具作用域分类

当前工具按名称正则分成三类：

- `browser`: 如 `browser` / `playwright` / `puppeteer` / `selenium` 等
- `network_adjacent`: 如 `webfetch` / `http` / `url` / `page` 等
- `out_of_scope`: 其他工具

## 6. 执行时序

### 6.1 Preflight

在任务开始前检查：

- 若意图是 `browser_access`
- 且 `browser.noFallback = true`
- 且当前无浏览器能力工具

则直接返回受控失败：`intent_execution_failed`。

### 6.2 Before Tool Execution

每次工具调用前执行拦截：

- `browser`：允许
- `network_adjacent`：在 `browser.networkAdjacentOnly = true` 下，仅允许前 `softBlockAfter` 次
- 超过阈值或调用 `out_of_scope`：阻断并返回 `tool_policy_blocked`

### 6.3 On Tool Settled

工具成功后记录命中：

- 若成功工具属于 `browser`，累加 `successfulBrowserCalls`

### 6.4 Completion Check

在任务完成前检查：

- 若意图是 `browser_access`
- 且 `browser.failTaskIfUnmet = true`
- 且全程没有任何浏览器工具成功

则返回受控失败：`intent_execution_failed`。

## 7. 受控停止原因

- `tool_policy_blocked`
  - 意图护栏阻止了本次工具调用（越界或偏航超阈值）。
- `intent_execution_failed`
  - 任务意图要求未满足（无浏览器能力或未完成有效浏览器执行）。

这两个停止原因都会写入任务执行元信息，供 UI / API / 回归测试使用。

## 8. 配置说明

配置路径：`agent.execution.intentGuard`

```json
{
  "intentGuard": {
    "enabled": true,
    "detector": "model",
    "softBlockAfter": 2,
    "browser": {
      "noFallback": true,
      "networkAdjacentOnly": true,
      "failTaskIfUnmet": true
    }
  }
}
```

字段解释：

- `enabled`: 是否启用意图护栏
- `detector`: `model` 或 `heuristic`
- `softBlockAfter`: 网络邻近工具允许的偏航次数
- `browser.noFallback`: 无浏览器能力时是否直接失败
- `browser.networkAdjacentOnly`: 是否禁止非网络邻近工具
- `browser.failTaskIfUnmet`: 未完成浏览器成功调用时是否标记失败

## 9. 观测与排障

建议从以下位置观察：

- 任务消息流（`tool.call` / `tool.result`）是否出现 browser 工具
- 任务元信息 `metadata.execution.stopReason`
- 失败文案中是否包含拦截原因

常见问题：

1. 一直 `intent_execution_failed`
   - 检查 MCP 是否暴露 browser 工具；
   - 检查 `browser.noFallback` 是否开启。
2. 出现 `tool_policy_blocked`
   - 检查模型是否在浏览器任务上反复调用 `webfetch` / 非相关工具；
   - 视情况调高 `softBlockAfter`（仅限临时调试）。

## 10. 测试建议

### 10.1 单测

```bash
bun test src/libs/agent/core/intent_guard.test.ts
bun test src/libs/agent/core/agent_runner.test.ts
bun test src/libs/agent/tools/registry.test.ts
```

### 10.2 集成回归

```bash
bun run test:server-chat
```

### 10.3 关键场景清单

1. 浏览器任务 + 存在 browser 工具：
   - 应出现 browser 工具调用并成功完成任务。
2. 浏览器任务 + 不存在 browser 工具：
   - 应直接 `intent_execution_failed`。
3. 浏览器任务 + 反复调用网络邻近工具：
   - 超过 `softBlockAfter` 后应触发 `tool_policy_blocked`。
4. 浏览器任务 + 仅非浏览器成功：
   - 完成前应被 `intent_execution_failed` 收敛。
