import { describe, expect, test } from "bun:test";
import type { AgentContext } from "../../../types/agent";
import { CONTEXT_POLICY } from "./context_policy";
import {
  compactContextMemory,
  mergeContextWithMemoryPolicy,
  sanitizeIncomingContextPatch,
} from "./context_sanitizer";

const createBaseContext = (): AgentContext => ({
  version: CONTEXT_POLICY.version,
  runtime: {
    round: 3,
    workspace: "/tmp/workspace/",
    datetime: "2026-02-25T10:00:00.000Z",
    startup_at: 1700000000000,
  },
  memory: {
    core: [],
    working: [],
    ephemeral: [],
  },
});

describe("context_sanitizer", () => {
  test("sanitizes incoming patch, strips system fields, filters by thresholds, and defaults confidence", () => {
    const context = createBaseContext();

    const patch = sanitizeIncomingContextPatch(
      {
        version: 1,
        runtime: {
          round: 999,
        },
        project: {
          name: "atom",
        },
        memory: {
          working: [
            {
              id: "drop-decay",
              type: "task",
              decay: 0.9,
              confidence: 0.95,
              round: 1,
              tags: ["x"],
              content: "too decayed",
            },
            {
              id: "drop-confidence",
              type: "task",
              decay: 0.3,
              confidence: 0.1,
              round: 1,
              tags: ["x"],
              content: "too uncertain",
            },
          ],
          ephemeral: [
            {
              id: "keep-default-confidence",
              type: "hint",
              decay: "0.7",
              round: "not-a-number",
              tags: [" a ", "a", "b", 1],
              content: "  keep me  ",
            },
          ],
        },
      },
      context,
    );

    expect("version" in patch).toBe(false);
    expect("runtime" in patch).toBe(false);
    expect(patch.project).toEqual({ name: "atom" });
    expect(patch.memory?.working).toEqual([]);
    expect(patch.memory?.ephemeral).toHaveLength(1);

    const block = patch.memory?.ephemeral?.[0];
    expect(block?.id).toBe("keep-default-confidence");
    expect(block?.confidence).toBe(0.5);
    expect(block?.round).toBe(context.runtime.round);
    expect(block?.tags).toEqual(["a", "b"]);
    expect(block?.content).toBe("keep me");
  });

  test("deduplicates duplicate ids by quality and then newer round when quality ties", () => {
    const context = createBaseContext();

    const patch = sanitizeIncomingContextPatch(
      {
        memory: {
          working: [
            {
              id: "task-1",
              type: "task",
              decay: 0.5,
              confidence: 0.7,
              round: 1,
              tags: ["a"],
              content: "older",
            },
            {
              id: "task-1",
              type: "task",
              decay: 0.5,
              confidence: 0.7,
              round: 2,
              tags: ["b"],
              content: "newer-same-quality",
            },
            {
              id: "task-2",
              type: "task",
              decay: 0.6,
              confidence: 0.6,
              round: 1,
              tags: ["x"],
              content: "lower",
            },
            {
              id: "task-2",
              type: "task",
              decay: 0.2,
              confidence: 0.95,
              round: 1,
              tags: ["y"],
              content: "higher",
            },
          ],
        },
      },
      context,
    );

    const working = patch.memory?.working ?? [];
    expect(working).toHaveLength(2);
    expect(working.find((item) => item.id === "task-1")?.content).toBe("newer-same-quality");
    expect(working.find((item) => item.id === "task-1")?.round).toBe(2);
    expect(working.find((item) => item.id === "task-2")?.content).toBe("higher");
  });

  test("limits oversized tiers and keeps higher-quality items first", () => {
    const context = createBaseContext();

    const working = Array.from({ length: 60 }, (_, index) => ({
      id: `task-${index}`,
      type: "task",
      decay: 0.3 + (index % 10) * 0.01,
      confidence: 0.95 - index * 0.005,
      round: 1,
      tags: ["t"],
      content: `item-${index}`,
    }));

    const patch = sanitizeIncomingContextPatch({ memory: { working } }, context);
    const sanitized = patch.memory?.working ?? [];

    expect(sanitized).toHaveLength(CONTEXT_POLICY.tiers.working.maxItems);
    expect(sanitized[0]?.id).toBe("task-0");
  });

  test("compactContextMemory cleans historical dirty memory and preserves unknown top-level fields", () => {
    const dirty = {
      ...createBaseContext(),
      project: { name: "atom" },
      memory: {
        core: [],
        working: [
          {
            id: "dup",
            type: "task",
            decay: 0.4,
            confidence: 0.8,
            round: 1,
            tags: ["a"],
            content: "old",
          },
          {
            id: "dup",
            type: "task",
            decay: 0.2,
            confidence: 0.95,
            round: 2,
            tags: ["b"],
            content: "new",
          },
          {
            id: "bad",
            type: "task",
            decay: 0.99,
            confidence: 0.99,
            round: 1,
            tags: [],
            content: "too-decayed",
          },
        ],
        ephemeral: [
          {
            id: "legacy-no-confidence",
            type: "hint",
            decay: 0.6,
            round: 1,
            tags: ["temp"],
            content: "legacy",
          },
        ],
      },
    } as unknown as AgentContext;

    const compacted = compactContextMemory(dirty);

    expect(compacted.project).toEqual({ name: "atom" });
    expect(compacted.memory.working).toHaveLength(1);
    expect(compacted.memory.working[0]?.content).toBe("new");
    expect(compacted.memory.ephemeral).toHaveLength(1);
    expect(compacted.memory.ephemeral[0]?.confidence).toBe(0.5);
  });

  test("automatically deletes expired blocks by round for working/ephemeral and keeps core", () => {
    const context = createBaseContext();
    context.runtime.round = 20;
    context.memory = {
      core: [
        {
          id: "core-old",
          type: "identity",
          decay: 0.1,
          confidence: 0.95,
          round: 1,
          tags: ["core"],
          content: "keep-core",
        },
      ],
      working: [
        {
          id: "working-expired",
          type: "task",
          decay: 0.2,
          confidence: 0.9,
          round: 1,
          tags: ["task"],
          content: "drop-working",
        },
        {
          id: "working-fresh",
          type: "task",
          decay: 0.2,
          confidence: 0.9,
          round: 10,
          tags: ["task"],
          content: "keep-working",
        },
      ],
      ephemeral: [
        {
          id: "temp-expired",
          type: "hint",
          decay: 0.2,
          confidence: 0.9,
          round: 10,
          tags: ["temp"],
          content: "drop-ephemeral",
        },
        {
          id: "temp-fresh",
          type: "hint",
          decay: 0.2,
          confidence: 0.9,
          round: 17,
          tags: ["temp"],
          content: "keep-ephemeral",
        },
      ],
    };

    const compacted = compactContextMemory(context);

    expect(compacted.memory.core.map((x) => x.id)).toEqual(["core-old"]);
    expect(compacted.memory.working.map((x) => x.id)).toEqual(["working-fresh"]);
    expect(compacted.memory.ephemeral.map((x) => x.id)).toEqual(["temp-fresh"]);
  });

  test("clamps future block round to current runtime round", () => {
    const context = createBaseContext();
    context.runtime.round = 4;

    const patch = sanitizeIncomingContextPatch(
      {
        memory: {
          working: [
            {
              id: "future",
              type: "task",
              decay: 0.2,
              confidence: 0.9,
              round: 999,
              tags: ["task"],
              content: "future block",
            },
          ],
        },
      },
      context,
    );

    expect(patch.memory?.working?.[0]?.round).toBe(4);
  });

  test("mergeContextWithMemoryPolicy merges memory tiers by id instead of array index", () => {
    const current = createBaseContext();
    current.memory.working = [
      {
        id: "a",
        type: "task",
        decay: 0.2,
        confidence: 0.9,
        round: 1,
        tags: ["x"],
        content: "A1",
      },
      {
        id: "b",
        type: "task",
        decay: 0.3,
        confidence: 0.9,
        round: 1,
        tags: ["y"],
        content: "B1",
      },
    ];

    const merged = mergeContextWithMemoryPolicy(current, {
      memory: {
        working: [
          {
            id: "b",
            type: "task",
            decay: 0.25,
            confidence: 0.95,
            round: 2,
            tags: ["y2"],
            content: "B2",
          },
        ],
      },
    });

    expect(merged.memory.working).toHaveLength(2);
    expect(merged.memory.working.find((item) => item.id === "a")?.content).toBe("A1");
    expect(merged.memory.working.find((item) => item.id === "b")?.content).toBe("B2");
  });

  test("mergeContextWithMemoryPolicy deep-merges unknown top-level execution metadata", () => {
    const current = createBaseContext() as AgentContext & {
      active_task_meta?: Record<string, unknown>;
    };
    current.active_task_meta = {
      id: "task-1",
      status: "running",
      execution: {
        segment_index: 1,
        tool_calls: { used: 1, limit: 40 },
      },
    };

    const patch = sanitizeIncomingContextPatch(
      {
        active_task_meta: {
          execution: {
            tool_calls: { remaining: 39 },
            model_steps: { used: 10, task_limit: 80 },
          },
        },
      },
      current,
    );

    const merged = mergeContextWithMemoryPolicy(current, patch) as AgentContext & {
      active_task_meta?: Record<string, any>;
    };

    expect(merged.active_task_meta?.id).toBe("task-1");
    expect(merged.active_task_meta?.execution?.segment_index).toBe(1);
    expect(merged.active_task_meta?.execution?.tool_calls).toEqual({
      used: 1,
      limit: 40,
      remaining: 39,
    });
    expect(merged.active_task_meta?.execution?.model_steps?.task_limit).toBe(80);
  });
});
