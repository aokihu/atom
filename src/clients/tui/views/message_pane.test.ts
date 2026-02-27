/**
 * Tests for Message Pane transformation logic.
 *
 * Purpose:
 * - Validate tool-group/todo-card collapse rules.
 * - Prevent chat card grouping regressions in complex message streams.
 */

import { describe, expect, test } from "bun:test";

import {
  collapseCompletedToolGroups,
  collapseTodoToolCards,
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
  test("collapses a completed tool group only when it exceeds 3 tools", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read" }),
      makeTool({ toolName: "ls", createdAt: 2 }),
      makeTool({ toolName: "write", createdAt: 3 }),
      makeTool({ toolName: "git", createdAt: 4 }),
    ]);

    expect(result).toHaveLength(1);
    const summary = result[0];
    expect(summary?.role).toBe("tool_group_summary");
    if (!summary || summary.role !== "tool_group_summary") {
      throw new Error("expected tool group summary");
    }
    expect(summary.executed).toBe(4);
    expect(summary.success).toBe(4);
    expect(summary.failed).toBe(0);
    expect(summary.status).toBe("done");
    expect(summary.step).toBe(1);
    expect(summary.taskId).toBe("task-1");
  });

  test("does not collapse a completed group at the 3-tool boundary", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read" }),
      makeTool({ toolName: "ls", createdAt: 2 }),
      makeTool({ toolName: "write", createdAt: 3 }),
    ]);

    expect(result).toHaveLength(3);
    expect(result.every((item) => item.role === "tool")).toBe(true);
  });

  test("does not collapse a running group at or below 5 tools", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "error" }),
      makeTool({ toolName: "write", status: "running" }),
      makeTool({ toolName: "git", status: "done" }),
      makeTool({ toolName: "bash", status: "done" }),
    ]);

    expect(result).toHaveLength(5);
    expect(result.every((item) => item.role === "tool")).toBe(true);
  });

  test("collapses a running group when it exceeds 5 tools", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "error" }),
      makeTool({ toolName: "write", status: "running" }),
      makeTool({ toolName: "git", status: "done" }),
      makeTool({ toolName: "bash", status: "done" }),
      makeTool({ toolName: "pwd", status: "done" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("tool_group_summary");
    if (result[0]?.role === "tool_group_summary") {
      expect(result[0].executed).toBe(6);
      expect(result[0].success).toBe(4);
      expect(result[0].failed).toBe(1);
      expect(result[0].status).toBe("running");
    }
  });

  test("collapses immediately after the last running tool finishes when completed threshold is met", () => {
    const before = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "done" }),
      makeTool({ toolName: "write", status: "done" }),
      makeTool({ toolName: "git", status: "running" }),
    ]);
    const after = collapseCompletedToolGroups([
      makeTool({ toolName: "read", status: "done" }),
      makeTool({ toolName: "ls", status: "done" }),
      makeTool({ toolName: "write", status: "done" }),
      makeTool({ toolName: "git", status: "done" }),
    ]);

    expect(before).toHaveLength(4);
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
      makeTool({ toolName: "pwd", taskId: "task-1" }),
      makeTool({ toolName: "git", taskId: "task-1" }),
      makeTool({ toolName: "write", taskId: "task-2" }),
      makeTool({ toolName: "git", taskId: "task-2" }),
      makeTool({ toolName: "cat", taskId: "task-2" }),
      makeTool({ toolName: "bash", taskId: "task-2" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("tool_group_summary");
    expect(result[1]?.role).toBe("tool_group_summary");
  });

  test("uses non-tool messages as hard boundaries between tool groups", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "read", step: 1 }),
      makeTool({ toolName: "ls", step: 1 }),
      makeTool({ toolName: "pwd", step: 2 }),
      makeTool({ toolName: "git", step: 2 }),
      makeAssistant("mid"),
      makeTool({ toolName: "write", step: 1, createdAt: 4 }),
      makeTool({ toolName: "git", step: 1, createdAt: 5 }),
      makeTool({ toolName: "cat", step: 2, createdAt: 6 }),
      makeTool({ toolName: "bash", step: 2, createdAt: 7 }),
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
      makeTool({ step: undefined, toolName: "pwd" }),
      makeTool({ step: undefined, toolName: "git" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("tool_group_summary");
    if (result[0]?.role === "tool_group_summary") {
      expect(result[0].executed).toBe(4);
      expect(result[0].step).toBeUndefined();
    }
  });

  test("shows a clickable collapse row after a manually expanded group", () => {
    const result = collapseCompletedToolGroups(
      [
        makeTool({ toolName: "read" }),
        makeTool({ toolName: "ls" }),
        makeTool({ toolName: "pwd" }),
        makeTool({ toolName: "git" }),
      ],
      { expandedGroupKeys: new Set(["task-1:0"]) },
    );

    expect(result).toHaveLength(5);
    expect(result.slice(0, 4).every((item) => item.role === "tool")).toBe(true);
    expect(result[4]?.role).toBe("tool_group_toggle");
    if (result[4]?.role === "tool_group_toggle") {
      expect(result[4].groupKey).toBe("task-1:0");
    }
  });

  test("does not collapse todo tool rows into tool group summaries", () => {
    const result = collapseCompletedToolGroups([
      makeTool({ toolName: "todo_list" }),
      makeTool({ toolName: "todo_add", createdAt: 2 }),
      makeTool({ toolName: "todo_complete", createdAt: 3 }),
      makeTool({ toolName: "todo_list", createdAt: 4 }),
    ]);

    expect(result).toHaveLength(4);
    expect(result.every((item) => item.role === "tool")).toBe(true);
  });

  test("collapses consecutive todo tool rows with same todo_id into one todo card group", () => {
    const result = collapseTodoToolCards([
      makeTool({
        toolName: "todo_list",
        resultDisplay: {
          version: 1,
          toolName: "todo_list",
          phase: "result",
          templateKey: "builtin.todo_list.result",
          data: { todo_id: "workspace", summary: "TODO list" },
        },
      }),
      makeTool({
        toolName: "todo_add",
        createdAt: 2,
        resultDisplay: {
          version: 1,
          toolName: "todo_add",
          phase: "result",
          templateKey: "builtin.todo_add.result",
          data: { todo_id: "workspace", summary: "Added item" },
        },
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("todo_card_group");
    if (result[0]?.role === "todo_card_group") {
      expect(result[0].messages).toHaveLength(2);
      expect(result[0].todoId).toBe("workspace");
      expect(result[0].taskId).toBe("task-1");
    }
  });

  test("does not render todo card group before a todo_list snapshot exists", () => {
    const result = collapseTodoToolCards([
      makeTool({
        toolName: "todo_add",
        resultDisplay: {
          version: 1,
          toolName: "todo_add",
          phase: "result",
          templateKey: "builtin.todo_add.result",
          data: { todo_id: "workspace", summary: "Added item", items: [{ id: 1, title: "a", status: "open", mark: "☐" }] },
        },
      }),
      makeTool({
        toolName: "todo_complete",
        createdAt: 2,
        resultDisplay: {
          version: 1,
          toolName: "todo_complete",
          phase: "result",
          templateKey: "builtin.todo_complete.result",
          data: { todo_id: "workspace", summary: "Done", items: [{ id: 1, title: "a", status: "done", mark: "✓" }] },
        },
      }),
    ]);

    expect(result).toHaveLength(0);
  });
});
