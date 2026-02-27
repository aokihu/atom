# Context Protocol --- Hybrid Mode (Text + JSON Snapshot)

Version: 3.0

------------------------------------------------------------------------

## Runtime Switch

contextMode = {MODE}

If contextMode = disabled:
- The agent MUST NOT output `<<<CONTEXT>>>`.
- All context enforcement rules are suspended for that response.
- The agent outputs only the normal response content.

------------------------------------------------------------------------

## Mandatory Rules (When contextMode = enabled)

1. Every response MUST include a `<<<CONTEXT>>>` section.
2. `<<<CONTEXT>>>` MUST appear at the very bottom of the response.
3. `<<<CONTEXT>>>` MUST be the ONLY separator between response text and structured context.
4. All content AFTER `<<<CONTEXT>>>` MUST be valid JSON.
5. JSON MUST be directly parseable by `JSON.parse()` without preprocessing.
6. No extra characters are allowed before or after the JSON block.
7. Context is a computable state snapshot, NOT narrative text.
8. System-controlled fields MUST be preserved exactly as received and MUST NOT be modified:
   - `version`
   - `runtime.round`
   - `runtime.workspace`
   - `runtime.datetime`
   - `runtime.startup_at`
   - `todo.summary`
   - `todo.total`
   - `todo.step`
9. `todo.cursor` is the ONLY `todo` subfield the model may update (optional).
   - If emitting `todo.cursor`, it MUST follow the strict schema defined below.
10. Memory blocks MUST be emitted only under `memory.core`, `memory.working`, `memory.ephemeral`, or `memory.longterm`.
11. Every memory block MUST contain all required fields:
    - `id`
    - `type`
    - `decay`
    - `confidence`
    - `round`
    - `tags`
    - `content`
12. `decay` MUST be a floating point number between 0 and 1.
13. `confidence` MUST be a floating point number between 0 and 1.
14. Low-quality memory blocks SHOULD be omitted proactively.
    - If `decay` is too high OR `confidence` is too low, do not emit the block.
15. Prefer updating existing memory blocks by stable `id` instead of creating duplicate IDs.
16. Within each memory tier, keep higher-quality blocks first and avoid redundant entries.

------------------------------------------------------------------------

## Strict Output Format (When enabled)

User Response Content...

\<\<`<CONTEXT>`{=html}\>\> {JSON}

No markdown wrapping around JSON. No XML tags. No comments inside JSON.

------------------------------------------------------------------------

## Context JSON Template

{
  "version": 3.0,
  "runtime": {
    "round": 1,
    "workspace": "/workspace/path/",
    "datetime": "2026-02-25T10:00:00.000Z",
    "startup_at": 1700000000000
  },
  "memory": {
    "core": [
      {
        "id": "core-001",
        "type": "identity",
        "decay": 0.05,
        "confidence": 0.95,
        "round": 1,
        "tags": ["agent", "identity"],
        "content": "长期核心记忆"
      }
    ],
    "working": [
      {
        "id": "work-001",
        "type": "task",
        "decay": 0.4,
        "confidence": 0.78,
        "round": 1,
        "tags": ["task", "active"],
        "content": "当前任务相关记忆"
      }
    ],
    "ephemeral": [
      {
        "id": "temp-001",
        "type": "hint",
        "decay": 0.75,
        "confidence": 0.55,
        "round": 1,
        "tags": ["temporary"],
        "content": "临时上下文信息"
      }
    ],
    "longterm": [
      {
        "id": "longterm-001",
        "type": "knowledge",
        "decay": 0.25,
        "confidence": 0.85,
        "round": 1,
        "tags": ["reference", "persistent"],
        "content": "可长期复用的业务知识"
      }
    ]
  },
  "todo": {
    "summary": "进行中 1/3（当前第2步）",
    "total": 3,
    "step": 2,
    "cursor": {
      "v": 1,
      "phase": "doing",
      "next": "todo_complete",
      "targetId": 2,
      "note": "完成当前步骤后继续验证"
    }
  },
  "capabilities": [{ "name": "memory", "scope": "write_once" }],
  "active_task": "当前执行任务摘要"
}

------------------------------------------------------------------------

## Structural Notes

### runtime (System Controlled Domain)

- `round`: conversation counter (monotonic, system managed)
- `workspace`: normalized workspace path (system managed)
- `datetime`: current system time (ISO 8601 string)
- `startup_at`: session start time (Unix epoch milliseconds)

The model may read but MUST NOT modify runtime fields.

### todo (Split Ownership Domain)

- `todo.summary` / `todo.total` / `todo.step`: system-computed progress projection (read-only for model)
- `todo.cursor`: agent intent cursor (optional, model-writable)

If emitting `todo.cursor`, use the strict shape:

```json
{
  "v": 1,
  "phase": "planning|doing|verifying|blocked",
  "next": "none|todo_list|todo_add|todo_update|todo_complete|todo_reopen|todo_remove|todo_clear_done",
  "targetId": 1,
  "note": "optional short note"
}
```

Rules:
- `targetId` MUST be `null` for `none`, `todo_list`, `todo_add`, `todo_clear_done`
- `targetId` MUST be a positive integer for `todo_update`, `todo_complete`, `todo_reopen`, `todo_remove`
- Do NOT manually modify `todo.summary`, `todo.total`, or `todo.step`

### memory (Model Evolution Domain)

- `core`: long-term persistent memory
- `working`: multi-round task memory
- `ephemeral`: short-lived temporary memory
- `longterm`: durable reusable memory pool (may include restored `tag_ref` content)
- When persistent memory is enabled, `memory.core` may be saved across sessions.
- Put only stable, high-value, reusable facts/preferences/constraints in `memory.core`.
- Put temporary progress and short-lived reasoning in `memory.working` or `memory.ephemeral`.
- Put broadly reusable but less-frequently-accessed knowledge into `memory.longterm`.
- Prefer reusing the same `memory.core[].id` when updating an existing long-term memory.

For tag-based cold memory placeholders:
- `content_state = "tag_ref"` means this block is a placeholder.
- `tag_id` links to the cold payload storage.
- `tag_summary` keeps a short human-readable placeholder summary.
- When tag payload is restored, `content_state` returns to `active`, and `rehydrated_at` may be set.

Memory lifecycle is governed by `decay`, `confidence`, and round progression.
