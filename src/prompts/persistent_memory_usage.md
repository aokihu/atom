# Persistent Memory Usage Guide (for `memory.core` + `memory.longterm`)

Use this guide to make persistent memory high-signal, stable, and reusable.

## Goal

`memory.core` and `memory.longterm` are durable knowledge. They should survive across sessions and help future tasks.

## What to store in `memory.core` / `memory.longterm`

Store only information that is stable and repeatedly useful:

- User long-term preferences (coding style, communication style, framework bias)
- Project constraints (required runtime, architecture boundaries, naming conventions)
- Durable decisions (accepted design choices and their constraints)
- Reusable operational facts (build/test commands that are consistently valid)
- High-value reusable references (frequent websites, endpoint docs, recurring locations, operational shortcuts)

## What NOT to store in `memory.core`

Do not store transient state:

- Per-turn scratch thoughts
- Temporary debugging traces
- One-off intermediate tool outputs
- Step-by-step progress that belongs to current task only

Place transient state in `memory.working` or `memory.ephemeral`.

## Tag-based cold memory (`tag_ref`)

When a memory becomes low activity but still likely reusable (`P(reuse) > 0.15`), do not discard it immediately:

- move full content into cold payload storage
- keep placeholder in-place with `content_state = "tag_ref"`
- preserve `tag_id` + `tag_summary`

On recall or explicit resolve (`memory_tag_resolve`), restore content by `tag_id`.

## ID stability and update policy

Always prefer updating existing memory by stable `id` instead of creating a new duplicate.

- Reuse the same `id` when the fact is the same concept with newer details
- Create a new `id` only when it is a genuinely different concept

Suggested `id` pattern:

- `project:domain:topic`
- `user:preference:topic`
- `team:convention:topic`

Use lowercase and `:` separators.

## Confidence and decay guidance

For `memory.core`:

- `confidence`: prefer `0.7` to `1.0`
- `decay`: prefer `0.0` to `0.35`

If confidence is low or the fact is uncertain, keep it out of `core`.

For `memory.longterm`:

- `confidence`: prefer `0.6` to `0.9`
- `decay`: prefer `0.1` to `0.45`

## Content quality rules

- Keep `content` concrete, short, and verifiable
- Include constraints and applicability (when it applies)
- Avoid vague statements that cannot guide future actions

## Tags strategy

Use tags as retrieval anchors:

- Add project/module/stack keywords
- Avoid noisy or redundant tags
- Keep tags focused on retrieval intent

## Conflict handling

If a new fact conflicts with old persistent memory:

- Keep the same `id` and update content to the latest confirmed fact
- Raise `confidence` only if the new fact is well-supported
- Avoid storing both old and new versions as separate duplicates

## Memory tool usage

When tool access is available, prefer explicit memory operations for high-value facts:

- write: `memory_write`
- retrieve/search: `memory_get`, `memory_search`, `memory_list_recent`
- maintain: `memory_update`, `memory_feedback`, `memory_delete`
- cold-memory restore/cleanup: `memory_tag_resolve`, `memory_compact`
