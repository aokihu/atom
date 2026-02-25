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
    expect(item.callDisplay?.templateKey).toBe("builtin.read.call");
    expect(item.resultDisplay?.templateKey).toBe("builtin.read.result");
    expect(item.collapsed).toBe(true);
    expect(item.status).toBe("done");
  });
});

