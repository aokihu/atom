/**
 * Tests for task-flow summary helpers.
 *
 * Purpose:
 * - Verify task completion and failure summary formatting logic.
 * - Keep stop-reason edge cases stable across runtime changes.
 */

import { describe, expect, test } from "bun:test";

import { summarizeCompletedTask } from "./task_flow";
import { TaskStatus } from "../../../types/task";

describe("task_flow summarizeCompletedTask", () => {
  test("keeps ordinary failures as error summaries", () => {
    const summary = summarizeCompletedTask({
      status: TaskStatus.Failed,
      error: { message: "boom" },
    });

    expect(summary.kind).toBe("error");
    expect(summary.statusNotice).toBe("Task failed: boom");
  });

  test("renders controlled incomplete failures as system summaries", () => {
    const summary = summarizeCompletedTask({
      status: TaskStatus.Failed,
      error: { message: "Task not completed: tool_budget_exhausted" },
      metadata: {
        execution: {
          completed: false,
          stopReason: "tool_budget_exhausted",
          totalToolCalls: 40,
          totalModelSteps: 80,
          segmentCount: 4,
        },
      },
    });

    expect(summary.kind).toBe("system");
    expect(summary.statusNotice).toContain("Task not completed: tool budget exhausted");
    expect(summary.statusNotice).toContain("tools 40");
    expect(summary.statusNotice).toContain("model steps 80");
    expect(summary.statusNotice).toContain("segments 4");
  });

  test("degrades gracefully when execution metadata is incomplete", () => {
    const summary = summarizeCompletedTask({
      status: TaskStatus.Failed,
      metadata: {
        execution: {
          completed: false,
          stopReason: "continuation_limit_reached",
        },
      },
    });

    expect(summary.kind).toBe("system");
    expect(summary.statusNotice).toBe("Task not completed: continuation limit reached");
  });
});
