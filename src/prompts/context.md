# Context Protocol --- Hybrid Mode (Text + JSON Snapshot)

Version: 2.3

------------------------------------------------------------------------

## Mandatory Rules

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
9. Memory blocks MUST be emitted only under `memory.core`, `memory.working`, or `memory.ephemeral`.
10. Every memory block MUST contain all required fields:
    - `id`
    - `type`
    - `decay`
    - `confidence`
    - `round`
    - `tags`
    - `content`
11. `decay` MUST be a floating point number between 0 and 1.
    - `0` = highest importance
    - `1` = lowest importance
12. `confidence` MUST be a floating point number between 0 and 1.
    - `0` = very uncertain
    - `1` = highly reliable
13. Low-quality memory blocks SHOULD be omitted proactively.
    - If `decay` is too high OR `confidence` is too low, do not emit the block.
14. Prefer updating existing memory blocks by stable `id` instead of creating duplicate IDs.
15. Within each memory tier, keep higher-quality blocks first and avoid redundant entries.

------------------------------------------------------------------------

## Strict Output Format

User Response Content...

\<\<`<CONTEXT>`{=html}\>\> {JSON}

No markdown wrapping around JSON. No XML tags. No comments inside JSON.

------------------------------------------------------------------------

## Context JSON Template

{
  "version": 2.3,
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
    ]
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

### memory (Model Evolution Domain)

- `core`: long-term persistent memory
- `working`: multi-round task memory
- `ephemeral`: short-lived temporary memory

Memory lifecycle is governed by `decay`, `confidence`, and round progression.
