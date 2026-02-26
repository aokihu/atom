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

  test("registers split todo tools and removes legacy todo tool", () => {
    const registry = createBuiltinToolRegistry({});

    expect("todo" in registry).toBe(false);
    expect("todo_list" in registry).toBe(true);
    expect("todo_add" in registry).toBe(true);
    expect("todo_update" in registry).toBe(true);
    expect("todo_complete" in registry).toBe(true);
    expect("todo_reopen" in registry).toBe(true);
    expect("todo_remove" in registry).toBe(true);
    expect("todo_clear_done" in registry).toBe(true);
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

  test("enforces shared tool budget across builtin and mcp tools", async () => {
    let used = 0;
    const registry = createToolRegistry({
      context: {
        toolBudget: {
          tryConsume(toolName: string) {
            if (used >= 2) {
              return {
                ok: false as const,
                used,
                remaining: 0,
                limit: 2,
                toolName,
              };
            }
            used += 1;
            return {
              ok: true as const,
              used,
              remaining: Math.max(0, 2 - used),
              limit: 2,
              toolName,
            };
          },
        },
      },
      mcpTools: {
        "memory:search": {
          execute: async () => ({ items: [] }),
        } as any,
      },
    });

    const filepath = `/tmp/atom-tool-budget-${Date.now()}.txt`;
    await Bun.write(filepath, "hello");

    await (registry.read as any).execute({ filepath });
    await (registry["memory:search"] as any).execute({ query: "ok" });
    await expect((registry["memory:search"] as any).execute({ query: "blocked" })).rejects.toThrow(
      /Tool budget exceeded/,
    );
  });

  test("suppresses registry tool messages in sdk_hooks mode while keeping budget checks", async () => {
    const messages: TaskOutputMessageDraft[] = [];
    let used = 0;

    const registry = createToolRegistry({
      context: {
        toolOutputMessageSource: "sdk_hooks",
        onOutputMessage: (message) => {
          messages.push(message);
        },
        toolBudget: {
          tryConsume(toolName: string) {
            if (used >= 1) {
              return {
                ok: false as const,
                used,
                remaining: 0,
                limit: 1,
                toolName,
              };
            }
            used += 1;
            return {
              ok: true as const,
              used,
              remaining: 0,
              limit: 1,
              toolName,
            };
          },
        },
      },
      mcpTools: {
        "memory:search": {
          execute: async () => ({ items: [] }),
        } as any,
      },
    });

    await (registry["memory:search"] as any).execute({ query: "first" }, { toolCallId: "mcp-1" });
    await expect((registry["memory:search"] as any).execute({ query: "second" })).rejects.toThrow(
      /Tool budget exceeded/,
    );

    expect(messages.filter((message) => message.category === "tool")).toHaveLength(0);
  });

  test("invokes onToolExecutionSettled callback for success and failure paths", async () => {
    const events: Array<{ toolName: string; ok: boolean; error?: string }> = [];
    const registry = createToolRegistry({
      context: {
        onToolExecutionSettled: (event) => {
          events.push({
            toolName: event.toolName,
            ok: event.ok,
            error: typeof event.error === "string" ? event.error : undefined,
          });
        },
      },
      mcpTools: {
        "memory:ok": {
          execute: async () => ({ items: [] }),
        } as any,
        "memory:semantic-error": {
          execute: async () => ({ error: "boom" }),
        } as any,
        "memory:throw": {
          execute: async () => {
            throw new Error("explode");
          },
        } as any,
      },
    });

    await (registry["memory:ok"] as any).execute({ query: "q1" });
    await (registry["memory:semantic-error"] as any).execute({ query: "q2" });
    await expect((registry["memory:throw"] as any).execute({ query: "q3" })).rejects.toThrow("explode");

    expect(events.map((event) => [event.toolName, event.ok])).toEqual([
      ["memory:ok", true],
      ["memory:semantic-error", false],
      ["memory:throw", false],
    ]);
  });
});
