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
});
