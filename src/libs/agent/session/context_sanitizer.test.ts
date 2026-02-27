import { describe, expect, test } from "bun:test";
import type { AgentContext } from "../../../types/agent";
import { CONTEXT_POLICY } from "./context_policy";
import {
  buildInjectedContextProjection,
  compactRawContextForStorage,
  mergeContextWithMemoryPolicy,
  sanitizeIncomingContextPatch,
  sanitizeIncomingContextPatchHard,
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
    longterm: [],
  },
});

describe("context_sanitizer", () => {
  test("hard sanitize strips system fields, keeps low-quality blocks in raw patch, defaults confidence, and defaults working status", () => {
    const context = createBaseContext();

    const patch = sanitizeIncomingContextPatchHard(
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
              id: "keep-high-decay-in-raw",
              type: "task",
              decay: 0.9,
              confidence: 0.95,
              round: 1,
              tags: ["x"],
              content: "too decayed for projection, but keep in raw",
            },
            {
              id: "keep-low-confidence-in-raw",
              type: "task",
              decay: 0.3,
              confidence: 0.1,
              round: 1,
              tags: ["x"],
              content: "too uncertain for projection, but keep in raw",
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
    expect(patch.memory?.working).toHaveLength(2);
    expect(patch.memory?.working?.every((block) => block.status === "open")).toBe(true);
    expect(patch.memory?.ephemeral).toHaveLength(1);

    const block = patch.memory?.ephemeral?.[0];
    expect(block?.id).toBe("keep-default-confidence");
    expect(block?.confidence).toBe(0.5);
    expect(block?.round).toBe(context.runtime.round);
    expect(block?.tags).toEqual(["a", "b"]);
    expect(block?.content).toBe("keep me");
  });

  test("hard sanitize deduplicates duplicate ids by quality and newer round on ties", () => {
    const context = createBaseContext();

    const patch = sanitizeIncomingContextPatchHard(
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

  test("projection filters by thresholds, TTL and working terminal status, and reports debug stats", () => {
    const raw = {
      ...createBaseContext(),
      runtime: {
        ...createBaseContext().runtime,
        round: 10,
      },
      last_task: { id: "old" },
      task_checkpoint: { task_id: "t1" },
      memory: {
        core: [
          {
            id: "core-keep",
            type: "identity",
            decay: 0.1,
            confidence: 0.95,
            round: 1,
            tags: ["core"],
            content: "keep",
          },
        ],
        working: [
          {
            id: "work-done",
            type: "task",
            decay: 0.1,
            confidence: 0.95,
            round: 9,
            tags: ["task"],
            content: "done task",
            status: "done",
          },
          {
            id: "work-low-confidence",
            type: "task",
            decay: 0.1,
            confidence: 0.1,
            round: 9,
            tags: ["task"],
            content: "low confidence",
            status: "open",
          },
          {
            id: "work-keep",
            type: "task",
            decay: 0.1,
            confidence: 0.95,
            round: 9,
            tags: ["task"],
            content: "keep",
            status: "open",
          },
        ],
        ephemeral: [
          {
            id: "temp-expired",
            type: "hint",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["temp"],
            content: "expired",
          },
          {
            id: "temp-keep",
            type: "hint",
            decay: 0.2,
            confidence: 0.9,
            round: 10,
            tags: ["temp"],
            content: "keep",
          },
        ],
        longterm: [],
      },
    } as AgentContext;

    const result = buildInjectedContextProjection(raw);

    expect((result.injectedContext as any).last_task).toBeUndefined();
    expect((result.injectedContext as any).task_checkpoint).toBeUndefined();
    expect(result.injectedContext.memory.core.map((x) => x.id)).toEqual(["core-keep"]);
    expect(result.injectedContext.memory.working.map((x) => x.id)).toEqual(["work-keep"]);
    expect(result.injectedContext.memory.ephemeral.map((x) => x.id)).toEqual(["temp-keep"]);

    expect(result.debug.round).toBe(10);
    expect(result.debug.rawCounts).toEqual({ core: 1, working: 3, ephemeral: 2, longterm: 0 });
    expect(result.debug.injectedCounts).toEqual({ core: 1, working: 1, ephemeral: 1, longterm: 0 });
    expect(result.debug.droppedByReason.working_status_terminal).toBe(1);
    expect(result.debug.droppedByReason.threshold_confidence).toBe(1);
    expect(result.debug.droppedByReason.expired_by_round).toBe(1);
  });

  test("compactRawContextForStorage preserves low-quality raw blocks, applies raw retention TTL, and preserves unknown fields", () => {
    const dirty = {
      ...createBaseContext(),
      runtime: {
        ...createBaseContext().runtime,
        round: 200,
      },
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
            status: "open",
          },
          {
            id: "dup",
            type: "task",
            decay: 0.2,
            confidence: 0.95,
            round: 2,
            tags: ["b"],
            content: "new",
            status: "open",
          },
          {
            id: "terminal-expired",
            type: "task",
            decay: 0.95,
            confidence: 0.2,
            round: 1,
            tags: ["t"],
            content: "keep raw unless expired by raw TTL",
            status: "done",
          },
          {
            id: "terminal-fresh",
            type: "task",
            decay: 0.95,
            confidence: 0.2,
            round: 100,
            tags: ["t"],
            content: "keep raw terminal",
            status: "failed",
          },
        ],
        ephemeral: [
          {
            id: "legacy-no-confidence",
            type: "hint",
            decay: 0.95,
            round: 200,
            tags: ["temp"],
            content: "legacy",
          },
          {
            id: "temp-expired",
            type: "hint",
            decay: 0.2,
            confidence: 0.9,
            round: 100,
            tags: ["temp"],
            content: "expired by raw retention ttl",
          },
        ],
        longterm: [],
      },
    } as unknown as AgentContext;

    const compacted = compactRawContextForStorage(dirty);

    expect((compacted as any).project).toEqual({ name: "atom" });
    expect(compacted.memory.working.map((x) => x.id)).toEqual(["dup", "terminal-fresh"]);
    expect(compacted.memory.working.find((x) => x.id === "dup")?.content).toBe("new");
    expect(compacted.memory.ephemeral.map((x) => x.id)).toEqual(["legacy-no-confidence"]);
    expect(compacted.memory.ephemeral[0]?.confidence).toBe(0.5);
  });

  test("compactRawContextForStorage enforces raw tier caps", () => {
    const context = createBaseContext();
    context.runtime.round = 50;
    context.memory.working = Array.from(
      { length: CONTEXT_POLICY.rawRetention.tiers.working.maxItems + 20 },
      (_, index) => ({
        id: `work-${index}`,
        type: "task",
        decay: 0.9,
        confidence: 0.1,
        round: 50 - (index % 5),
        tags: ["w"],
        content: `item-${index}`,
        status: "open" as const,
      }),
    );

    const compacted = compactRawContextForStorage(context);
    expect(compacted.memory.working.length).toBe(CONTEXT_POLICY.rawRetention.tiers.working.maxItems);
  });

  test("clamps future block round to current runtime round", () => {
    const context = createBaseContext();
    context.runtime.round = 4;

    const patch = sanitizeIncomingContextPatchHard(
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
            tags: ["y", "z"],
            content: "B2",
          },
          {
            id: "c",
            type: "task",
            decay: 0.4,
            confidence: 0.8,
            round: 2,
            tags: ["n"],
            content: "C1",
          },
        ],
      },
    });

    expect(merged.memory.working.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
    expect(merged.memory.working.find((item) => item.id === "a")?.content).toBe("A1");
    expect(merged.memory.working.find((item) => item.id === "b")?.content).toBe("B2");
    expect(merged.memory.working.find((item) => item.id === "c")?.content).toBe("C1");
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

  test("model source may update todo.cursor but cannot overwrite todo progress fields", () => {
    const current = {
      ...createBaseContext(),
      todo: {
        summary: "进行中 1/3（当前第2步）",
        total: 3,
        step: 2,
      },
    } as AgentContext;

    const patch = sanitizeIncomingContextPatchHard(
      {
        todo: {
          summary: "hack",
          total: 999,
          step: 999,
          cursor: {
            v: 1,
            phase: "doing",
            next: "todo_complete",
            targetId: 2,
            note: " next ",
          },
        },
      },
      current,
      { source: "model" },
    );

    expect(patch.todo).toEqual({
      cursor: {
        v: 1,
        phase: "doing",
        next: "todo_complete",
        targetId: 2,
        note: "next",
      },
    });

    const merged = mergeContextWithMemoryPolicy(current, patch);
    expect(merged.todo).toEqual({
      summary: "进行中 1/3（当前第2步）",
      total: 3,
      step: 2,
      cursor: {
        v: 1,
        phase: "doing",
        next: "todo_complete",
        targetId: 2,
        note: "next",
      },
    });
  });

  test("invalid model todo cursor patch is discarded and existing cursor is preserved", () => {
    const current = {
      ...createBaseContext(),
      todo: {
        summary: "进行中 0/1（当前第1步）",
        total: 1,
        step: 1,
        cursor: {
          v: 1,
          phase: "planning",
          next: "todo_list",
          targetId: null,
        },
      },
    } as AgentContext;

    const patch = sanitizeIncomingContextPatchHard(
      {
        todo: {
          cursor: {
            v: 1,
            phase: "doing",
            next: "todo_complete",
            targetId: null,
          },
        },
      },
      current,
      { source: "model" },
    );

    expect((patch as any).todo).toBeUndefined();
    const merged = mergeContextWithMemoryPolicy(current, patch);
    expect((merged.todo as any)?.cursor).toEqual((current.todo as any)?.cursor);
  });

  test("system source may update todo progress while preserving existing cursor", () => {
    const current = {
      ...createBaseContext(),
      todo: {
        summary: "进行中 0/2（当前第1步）",
        total: 2,
        step: 1,
        cursor: {
          v: 1,
          phase: "doing",
          next: "todo_complete",
          targetId: 1,
        },
      },
    } as AgentContext;

    const patch = sanitizeIncomingContextPatchHard(
      {
        todo: {
          summary: "进行中 1/2（当前第2步）",
          total: 2,
          step: 2,
        },
      },
      current,
      { source: "system" },
    );

    const merged = mergeContextWithMemoryPolicy(current, patch);
    expect(merged.todo).toEqual({
      summary: "进行中 1/2（当前第2步）",
      total: 2,
      step: 2,
      cursor: {
        v: 1,
        phase: "doing",
        next: "todo_complete",
        targetId: 1,
      },
    });
  });
});
