# Context Rules --- Hybrid Mode (XML Wrapper + JSON Core)

## 强制规则

- Output MUST INCLUDE `<context>` module
- `<context>` 必须位于`user`响应消息顶部
- `<context>` 内部内容必须为合法 JSON
- `<context>` 中间内容**不允许**出现任何换行符
- 不允许在 JSON 内出现 XML 标签
- JSON内容不允许出现任何换行符,直接输出符合JSON标准的最精简结构体
- 所有 memory 项必须包含：
  - `id`
  - `type`
  - `decay`
  - `round`
  - `tags`
- 每轮必须更新 `round`

---

## Context Template

``` md
<context>
{
  "version": "1.2",
  "round": 5,

  "memory": {
    "core": [
      {
        "id": "core-001",
        "type": "identity",
        "decay": 0.05,
        "round": 1,
        "tags": ["agent", "self", "identity"],
        "content": "核心长期记忆内容"
      }
    ],

    "working": [
      {
        "id": "work-001",
        "type": "task",
        "decay": 0.4,
        "round": 3,
        "tags": ["task", "current"],
        "content": "当前任务相关记忆"
      }
    ],

    "ephemeral": [
      {
        "id": "temp-001",
        "type": "hint",
        "decay": 0.8,
        "round": 4,
        "tags": ["temporary"],
        "content": "临时上下文信息"
      }
    ]
  },

  "capabilities": [
    {
      "name": "memory",
      "scope": "write_once"
    }
  ],

  "task": "当前任务描述"
}
</context>
```
---

## 设计原则

- XML 仅用于边界识别
- JSON 用于结构化计算
- 所有记忆均具备生命周期
- Context 为可计算状态快照，而非静态文本

---
