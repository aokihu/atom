import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOL_NAMES,
  createBuiltinToolRegistry,
  createToolRegistry,
} from "./index";
import type { TaskOutputMessageDraft } from "../../../types/http";

describe("tool registry", () => {
  test("creates builtin tool registry from metadata list", () => {
    const registry = createBuiltinToolRegistry({});

    for (const toolName of BUILTIN_TOOL_NAMES) {
      expect(toolName in registry).toBe(true);
    }
  });

  test("merges mcp tools with builtin tools", () => {
    const registry = createToolRegistry({
      context: {},
      mcpTools: {
        "memory:search": { stub: true } as any,
      },
    });

    expect("memory:search" in registry).toBe(true);
    expect("read" in registry).toBe(true);
  });

  test("throws on tool name conflict", () => {
    expect(() =>
      createToolRegistry({
        context: {},
        mcpTools: {
          read: { stub: true } as any,
        },
      }),
    ).toThrow("Tool name conflict: read");
  });

  test("emits structured tool displays for builtin tools and keeps unknown tools optional", async () => {
    const messages: TaskOutputMessageDraft[] = [];
    const registry = createToolRegistry({
      context: {
        onOutputMessage: (message) => {
          messages.push(message);
        },
      },
      mcpTools: {
        "memory:search": {
          execute: async () => ({ items: [] }),
        } as any,
      },
    });

    const filepath = `/tmp/atom-tool-display-${Date.now()}.txt`;
    await Bun.write(filepath, "hello\nworld\n");

    await (registry.read as any).execute({ filepath }, { toolCallId: "builtin-1" });
    await (registry["memory:search"] as any).execute({ query: "demo" }, { toolCallId: "mcp-1" });

    const builtinCall = messages.find(
      (message) => message.category === "tool" && message.type === "tool.call" && message.toolName === "read",
    );
    const builtinResult = messages.find(
      (message) => message.category === "tool" && message.type === "tool.result" && message.toolName === "read",
    );
    const mcpCall = messages.find(
      (message) =>
        message.category === "tool" && message.type === "tool.call" && message.toolName === "memory:search",
    );
    const mcpResult = messages.find(
      (message) =>
        message.category === "tool" && message.type === "tool.result" && message.toolName === "memory:search",
    );

    expect(builtinCall).toBeDefined();
    expect(builtinCall && "inputDisplay" in builtinCall ? builtinCall.inputDisplay?.templateKey : undefined)
      .toBe("builtin.read.call");
    expect(builtinResult).toBeDefined();
    expect(builtinResult && "outputDisplay" in builtinResult ? builtinResult.outputDisplay?.templateKey : undefined)
      .toBe("builtin.read.result");

    expect(mcpCall).toBeDefined();
    expect(mcpCall && "inputDisplay" in mcpCall ? mcpCall.inputDisplay : undefined).toBeUndefined();
    expect(mcpResult).toBeDefined();
    expect(mcpResult && "outputDisplay" in mcpResult ? mcpResult.outputDisplay : undefined).toBeUndefined();
  });
});
