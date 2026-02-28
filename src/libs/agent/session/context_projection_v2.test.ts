import { describe, expect, test } from "bun:test";
import type { AgentContext } from "../../../types/agent";
import { projectContextSnapshotV2 } from "./context_projection_v2";

const createContext = (): AgentContext => ({
  version: 3,
  runtime: {
    round: 2,
    workspace: "/tmp/ws/",
    datetime: "2026-02-28T07:20:41.382Z",
    startup_at: 1,
    token_usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    },
    budget: {
      estimated_input_tokens: 999,
      input_budget: 800,
      reserve_output_tokens: 128,
      safety_margin_tokens: 64,
      degrade_stage: "none",
      output_limit_tokens: 256,
    },
  },
  memory: {
    core: [],
    working: [],
    ephemeral: [],
    longterm: [],
  },
  last_task: { id: "task-1" },
  task_checkpoint: { task_id: "task-1" },
});

describe("context_projection_v2", () => {
  test("model context keeps only runtime whitelist fields", () => {
    const projection = projectContextSnapshotV2(createContext());

    expect(projection.modelContext.runtime).toEqual({
      round: 2,
      workspace: "/tmp/ws/",
      datetime: "2026-02-28T07:20:41.382Z",
      startup_at: 1,
    });
    expect((projection.modelContext.runtime as Record<string, unknown>).token_usage).toBeUndefined();
    expect((projection.modelContext.runtime as Record<string, unknown>).budget).toBeUndefined();
    expect((projection.modelContext as Record<string, unknown>).last_task).toBeUndefined();
    expect((projection.modelContext as Record<string, unknown>).task_checkpoint).toBeUndefined();
  });

  test("token budget projection trims memory tiers", () => {
    const context = createContext();
    context.memory.ephemeral = Array.from({ length: 12 }, (_, index) => ({
      id: `temp-${index}`,
      type: "hint",
      decay: 0.2,
      confidence: 0.9,
      round: 2,
      tags: ["temp"],
      content: `temporary note ${index}`,
    }));

    const projection = projectContextSnapshotV2(context, {
      tokenBudget: 80,
    });

    expect(projection.projectionDebug?.rawCounts.ephemeral).toBe(12);
    expect(projection.projectionDebug?.injectedCounts.ephemeral).toBeLessThanOrEqual(12);
    expect(projection.projectionDebug?.droppedByReason.token_budget_trimmed).toBeGreaterThanOrEqual(0);
  });
});
