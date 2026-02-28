/**
 * Tests for TUI runtime state model.
 *
 * Purpose:
 * - Validate state mutation behavior and tool-message patching logic.
 * - Ensure reducer-like updates remain backward compatible.
 */

import { describe, expect, test } from "bun:test";

import { TuiClientState } from "./state";

describe("TuiClientState tool messages", () => {
  test("retains call context when updating tool message with result data", () => {
    const state = new TuiClientState({
      terminal: { columns: 120, rows: 40 },
      agentName: "Atom",
    });

    const id = state.appendToolMessage({
      toolName: "read",
      step: 2,
      callSummary: "{\"filepath\":\"/tmp/a.txt\"}",
      callDisplay: {
        version: 1,
        toolName: "read",
        phase: "call",
        templateKey: "builtin.read.call",
        data: { fields: [{ label: "filepath", value: "/tmp/a.txt" }] },
      },
      collapsed: false,
      status: "running",
    });

    const updated = state.updateToolMessage(id, {
      step: 2,
      resultSummary: "{\"size\":11}",
      resultDisplay: {
        version: 1,
        toolName: "read",
        phase: "result",
        templateKey: "builtin.read.result",
        data: { fields: [{ label: "lineCount", value: "2" }] },
      },
      collapsed: true,
      status: "done",
    });

    expect(updated).toBe(true);
    const item = state.chatStream.find((entry) => entry.id === id);
    expect(item?.role).toBe("tool");
    if (!item || item.role !== "tool") {
      throw new Error("tool item missing");
    }
    expect(item.toolName).toBe("read");
    expect(item.step).toBe(2);
    expect(item.callDisplay?.templateKey).toBe("builtin.read.call");
    expect(item.resultDisplay?.templateKey).toBe("builtin.read.result");
    expect(item.collapsed).toBe(true);
    expect(item.status).toBe("done");
  });

  test("clears only session view content while preserving runtime state", () => {
    const state = new TuiClientState({
      terminal: { columns: 120, rows: 40 },
      agentName: "Atom",
    });

    state.phase = "polling";
    state.connection = "ok";
    state.activeTaskId = "task-1";
    state.statusNotice = "Working";
    state.mcpConnected = 1;
    state.mcpTotal = 2;
    state.contextModalOpen = true;
    state.contextModalTitle = "Context";
    state.contextModalText = "content";

    state.appendLog("system", "line");
    state.appendChatMessage("user", "hello");

    expect(state.entries.length).toBeGreaterThan(0);
    expect(state.chatStream.length).toBeGreaterThan(0);

    state.clearSessionView();

    expect(state.entries).toEqual([]);
    expect(state.chatStream).toEqual([]);
    expect(state.phase).toBe("polling");
    expect(state.connection).toBe("ok");
    expect(state.activeTaskId).toBe("task-1");
    expect(state.statusNotice).toBe("Working");
    expect(state.mcpConnected).toBe(1);
    expect(state.mcpTotal).toBe(2);
    expect(state.contextModalOpen).toBe(true);
    expect(state.contextModalTitle).toBe("Context");
    expect(state.contextModalText).toBe("content");
  });
});
