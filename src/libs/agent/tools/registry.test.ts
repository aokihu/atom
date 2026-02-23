import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOL_NAMES,
  createBuiltinToolRegistry,
  createToolRegistry,
} from "./index";

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
});
