import { describe, expect, test } from "bun:test";

import {
  collapseCompletedToolGroups,
  type ChatMessageCardInput,
} from "./message_pane";

const makeTool = (
  patch: Partial<Extract<ChatMessageCardInput, { role: "tool" }>> = {},
): Extract<ChatMessageCardInput, { role: "tool" }> => ({
  role: "tool",
  toolName: "read",
  step: 1,
  collapsed: true,
  status: "done",
  taskId: "task-1",
  createdAt: 1,
  ...patch,
});

const makeAssistant = (text = "done"): ChatMessageCardInput => ({
  role: "assistant",
  text,
  createdAt: 1,
  taskId: "task-1",
});

describe("collapseCompletedToolGroups", () => {
  test("collapses a completed same-step tool group into one summary row", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read" }),
      makeTool({ toolName: "ls", createdAt: 2 }),
      makeTool({ toolName: "write", createdAt: 3 }),
    ]);

    expect(result).toHaveLength(1);
    const summary = result[0];
    expect(summary?.role).toBe("tool_group_summary");
    if (!summary || summary.role !== "tool_group_summary") {
      throw new Error("expected tool group summary");
    }
    expect(summary.executed).toBe(3);
    expect(summary.success).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.status).toBe("done");
    expect(summary.step).toBe(1);
    expect(summary.taskId).toBe("task-1");
  });

  test("does not collapse a group while any tool is still running", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "error" }),
      makeTool({ toolName: "write", status: "running" }),
    ]);

    expect(result).toHaveLength(3);
    expect(result.every((item) => item.role === "tool")).toBe(true);
  });

  test("collapses immediately after the last running tool finishes", () => {
    const before = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "running" }),
    ]);
    const after = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "done" }),
    ]);

    expect(before).toHaveLength(2);
    expect(before.every((item) => item.role === "tool")).toBe(true);

    expect(after).toHaveLength(1);
    expect(after[0]?.role).toBe("tool_group_summary");
  });

  test("collapses failed groups and reports success/failed counts", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "error" }),
      makeTool({ toolName: "write", status: "done" }),
      makeTool({ toolName: "git", status: "error" }),
    ]);

    const summary = result[0];
    expect(result).toHaveLength(1);
    expect(summary?.role).toBe("tool_group_summary");
    if (!summary || summary.role !== "tool_group_summary") {
      throw new Error("expected tool group summary");
    }
    expect(summary.executed).toBe(4);
    expect(summary.success).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.status).toBe("error");
  });

  test("does not collapse a single-tool group", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("tool");
  });

  test("collapses adjacent different steps within the same task tool block", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", step: 1 }),
      makeTool({ toolName: "ls", step: 1 }),
      makeTool({ toolName: "write", step: 2 }),
      makeTool({ toolName: "git", step: 2 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("tool_group_summary");
    if (result[0]?.role === "tool_group_summary") {
      expect(result[0].executed).toBe(4);
      expect(result[0].step).toBeUndefined();
    }
  });

  test("does not merge adjacent tool rows from different tasks", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", taskId: "task-1" }),
      makeTool({ toolName: "ls", taskId: "task-1" }),
      makeTool({ toolName: "write", taskId: "task-2" }),
      makeTool({ toolName: "git", taskId: "task-2" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("tool_group_summary");
    expect(result[1]?.role).toBe("tool_group_summary");
  });

  test("uses non-tool messages as hard boundaries between tool groups", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", step: 1 }),
      makeTool({ toolName: "ls", step: 1 }),
      makeAssistant("mid"),
      makeTool({ toolName: "write", step: 1, createdAt: 4 }),
      makeTool({ toolName: "git", step: 1, createdAt: 5 }),
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]?.role).toBe("tool_group_summary");
    expect(result[1]?.role).toBe("assistant");
    expect(result[2]?.role).toBe("tool_group_summary");
  });

  test("collapses a same-task tool block even when step is missing", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ step: undefined }),
      makeTool({ step: undefined, toolName: "ls" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("tool_group_summary");
    if (result[0]?.role === "tool_group_summary") {
      expect(result[0].executed).toBe(2);
      expect(result[0].step).toBeUndefined();
    }
  });
});
