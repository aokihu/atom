# TODO Tool Usage Guide

当内置 TODO tools（如 `todo_list`、`todo_add` 等）可用时，你应优先使用它们管理多步骤任务，而不是仅依赖自然语言记忆。

## 目标

- 让任务拆解、执行进度、完成状态可追踪
- 在长任务或多轮对话中保持一致性
- 降低遗漏步骤的风险

## 何时使用 TODO tools

满足以下任一条件时，应使用 TODO tools：

- 用户请求包含多个子任务或明确的 TODO/清单需求
- 任务预计需要多步执行（阅读、修改、测试、验证、总结）
- 任务会跨多轮对话继续推进
- 你需要显式跟踪“待办 / 已完成”

以下情况可以不使用：

- 单步且一次性完成的简单问答
- 纯闲聊或无需执行的讨论

## 使用原则

1. 开始前先 `todo_list`
- 先查看当前 TODO，避免重复创建。

2. 任务拆解后 `todo_add`
- 每条 TODO 应该是可执行动作，标题简短明确。
- 标题优先使用动词开头（例如：`实现 todo sqlite 工具`、`补充单测`）。

3. 执行中及时更新
- 任务内容变化时使用 `todo_update` 修改标题或备注。
- 完成后立即 `todo_complete`，不要集中到最后一次性标记。

4. 结束前做收尾检查
- 使用 `todo_list` 检查是否仍有未完成项。
- 仅在确认不再需要时才 `todo_remove` 或 `todo_clear_done`。

## 推荐工作流

1. `todo_list` 查看现有任务
2. `todo_add` 创建本轮任务项（必要时拆分多条）
3. 执行任务
4. `todo_update`（可选）补充更准确标题/备注
5. `todo_complete` 标记完成
6. `todo_list` 复查剩余项

## 工具说明（简版）

- `todo_list`: 查询任务列表，可按 `status` 过滤（`all` / `open` / `done`）
- `todo_add`: 新增任务（`title` 必填，`note` 可选）
- `todo_update`: 更新任务（`id` 必填，`title` / `note` 至少一个）
- `todo_complete`: 标记完成（`id` 必填）
- `todo_reopen`: 恢复未完成（`id` 必填）
- `todo_remove`: 删除单条任务（`id` 必填）
- `todo_clear_done`: 清空所有已完成任务

## 与 Context 联动

- 上下文会包含 TODO 信息，格式为：`todo: { summary, total, step, cursor? }`
- 应优先参考 `context.todo` 判断当前任务推进阶段，再决定是否新增/更新/完成 TODO
- `summary` / `total` / `step` 由系统程序维护（从 TODO 数据库计算），不要手动改写
- `summary` 是人类可读进度摘要；`total` 是 TODO 总数；`step` 是当前步骤序号（从 1 开始；无 TODO 时为 0）
- 你只能在 `context.todo.cursor` 中表达“当前意图 / 下一步动作”，供程序读取和校验
- TODO 不跨重启持久化：本地 Agent 启动时会自动清空 TODO 数据库

### `context.todo.cursor`（严格格式）

仅在需要表达下一步动作时写入，格式必须严格可解析：

```json
{
  "todo": {
    "cursor": {
      "v": 1,
      "phase": "doing",
      "next": "todo_complete",
      "targetId": 2,
      "note": "完成当前步骤后继续验证"
    }
  }
}
```

规则：
- `targetId` 仅在 `todo_update` / `todo_complete` / `todo_reopen` / `todo_remove` 时填写正整数
- `todo_list` / `todo_add` / `todo_clear_done` / `none` 必须使用 `targetId: null`
- `note` 保持简短（短句即可）
- 非法 `cursor` 会被程序丢弃（并保留旧值）
- TODO 工具执行成功后，程序会自动刷新 `context.todo.summary/total/step`

## 行为约束

- 不要为同一任务重复创建多条相似 TODO。
- 不要把很长的自然语言段落放进 `title`；详细内容放到 `note`。
- 如果用户明确要求不记录、不持久化或不使用 TODO 工具，必须遵从。
- 汇报结果时，应与 TODO 状态保持一致（已完成项已标记完成）。
- 当上下文中存在 `active_task` 且 `active_task_meta.status = "running"` 时，应优先结合上下文继续推进未完成任务。
- 如果存在 `active_task_meta.execution`，应优先依据剩余预算选择高价值工具动作，并尽量在预算内完成验证与收尾。
- 任务未完成时不要只停留在计划/建议，应尽量使用工具执行并推进到明确状态。
- 当预算接近耗尽时，应优先输出：已完成项、当前阻塞、最小下一步动作。
