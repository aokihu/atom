# Context Protocol --- Hybrid Mode (Text + JSON Snapshot)

Version: 2.2

------------------------------------------------------------------------

## Runtime Switch

contextMode = {MODE}

If contextMode = disabled: - The agent MUST NOT output
\<\<`<CONTEXT>`{=html}\>\>. - All context enforcement rules are
suspended for that response. - The agent outputs only the normal
response content.

------------------------------------------------------------------------

## Mandatory Rules (When contextMode = enabled)

1.  Every response MUST include a `<<<CONTEXT>>>` section.
2.  `<<<CONTEXT>>>` MUST appear at the very bottom of the response.
3.  `<<<CONTEXT>>>` MUST be the ONLY separator between response text and
    structured context.
4.  All content AFTER `<<<CONTEXT>>>` MUST be valid JSON.
5.  JSON MUST be directly parseable by `JSON.parse()` without
    preprocessing.
6.  No extra characters are allowed before or after the JSON block.
7.  `round`, `datetime`, and `startup_at` are SYSTEM-INJECTED fields.
    -   The model MUST NOT modify them.
    -   The model MUST preserve them exactly as received.
8.  All memory objects MUST contain:
    -   `id`
    -   `type`
    -   `decay`
    -   `round`
    -   `tags`
    -   `content`
9.  `decay` MUST be a floating point number between 0 and 1.
    -   0 = highest importance
    -   1 = lowest importance
10. Context represents a computable state snapshot, NOT narrative text.

------------------------------------------------------------------------

## Strict Output Format (When enabled)

User Response Content...

\<\<`<CONTEXT>`{=html}\>\> {JSON}

No markdown wrapping around JSON. No XML tags. No comments inside JSON.

------------------------------------------------------------------------

## Context JSON Template

{ "version": "2.2", "runtime": { "round": 1, "datetime":
"2026-02-20T18:45:12Z", "startup_at": "2026-02-20T18:30:00Z" },
"memory": { "core": \[ { "id": "core-001", "type": "identity", "decay":
0.05, "round": 1, "tags": \["agent", "identity"\], "content":
"长期核心记忆" } \], "working": \[ { "id": "work-001", "type": "task",
"decay": 0.4, "round": 1, "tags": \["task", "active"\], "content":
"当前任务相关记忆" } \], "ephemeral": \[ { "id": "temp-001", "type":
"hint", "decay": 0.8, "round": 1, "tags": \["temporary"\], "content":
"临时上下文信息" } \] }, "capabilities": \[ { "name": "memory", "scope":
"write_once" } \], "active_task": "当前执行任务摘要" }

------------------------------------------------------------------------

## Structural Notes

### runtime (System Controlled Domain)

-   round: conversation counter (monotonic, system managed)
-   datetime: current system time (ISO 8601)
-   startup_at: session start time (ISO 8601)

The model may read but MUST NOT modify runtime fields.

### memory (Model Evolution Domain)

-   core: long-term persistent memory
-   working: multi-round task memory
-   ephemeral: short-lived temporary memory

Memory lifecycle is governed by decay and round progression.
