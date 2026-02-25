import { describe, expect, mock, test } from "bun:test";

import { initMCPTools } from "./index";

class FakeStdioTransport {
  public readonly config: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  };

  public onclose?: () => void;
  public onerror?: (error: unknown) => void;
  public onmessage?: (message: unknown) => void;

  constructor(config: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }) {
    this.config = config;
  }

  async start() {}
  async send(_message: unknown) {}
  async close() {}
}

describe("initMCPTools", () => {
  test("supports stdio MCP transport", async () => {
    let receivedTransport: unknown;
    let closeCount = 0;

    mock.module("@ai-sdk/mcp/mcp-stdio", () => ({
      Experimental_StdioMCPTransport: FakeStdioTransport,
    }));

    mock.module("@ai-sdk/mcp", () => ({
      createMCPClient: async (options: { transport: unknown }) => {
        receivedTransport = options.transport;
        return {
          tools: async () =>
            ({
              search: { description: "search" },
            }) as Record<string, unknown>,
          close: async () => {
            closeCount += 1;
          },
        };
      },
    }));

    const result = await initMCPTools({
      servers: [
        {
          id: "fs",
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
            env: { NODE_ENV: "test" },
            cwd: "/tmp",
          },
        },
      ],
    });

    expect(receivedTransport).toBeInstanceOf(FakeStdioTransport);
    expect((receivedTransport as FakeStdioTransport).config).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      env: { NODE_ENV: "test" },
      cwd: "/tmp",
    });

    expect(Object.keys(result.tools)).toEqual(["fs__search"]);
    expect(result.status).toEqual([
      {
        id: "fs",
        enabled: true,
        available: true,
        transportType: "stdio",
        target: "npx",
        toolCount: 1,
        toolNames: ["search"],
      },
    ]);

    await result.dispose();
    await result.dispose();
    expect(closeCount).toBe(1);
  });

  test("closes client when tool discovery fails", async () => {
    let closeCount = 0;

    mock.module("@ai-sdk/mcp/mcp-stdio", () => ({
      Experimental_StdioMCPTransport: FakeStdioTransport,
    }));

    mock.module("@ai-sdk/mcp", () => ({
      createMCPClient: async () => ({
        tools: async () => {
          throw new Error("tools failed");
        },
        close: async () => {
          closeCount += 1;
        },
      }),
    }));

    const result = await initMCPTools({
      servers: [
        {
          id: "fs",
          transport: {
            type: "stdio",
            command: "npx",
          },
        },
      ],
    });

    expect(result.tools).toEqual({});
    expect(result.status).toEqual([
      {
        id: "fs",
        enabled: true,
        available: false,
        transportType: "stdio",
        target: "npx",
        message: "tools failed",
      },
    ]);
    expect(closeCount).toBe(1);

    await result.dispose();
    expect(closeCount).toBe(1);
  });

  test("disposes http MCP clients", async () => {
    let closeCount = 0;
    let receivedTransport: unknown;

    mock.module("@ai-sdk/mcp", () => ({
      createMCPClient: async (options: { transport: unknown }) => {
        receivedTransport = options.transport;
        return {
          tools: async () =>
            ({
              read: { description: "read" },
            }) as Record<string, unknown>,
          close: async () => {
            closeCount += 1;
          },
        };
      },
    }));

    const result = await initMCPTools({
      servers: [
        {
          id: "memory",
          transport: {
            type: "http",
            url: "http://localhost:8787/mcp",
            headers: {
              Authorization: "Bearer test",
            },
          },
        },
      ],
    });

    expect(receivedTransport).toEqual({
      type: "http",
      url: "http://localhost:8787/mcp",
      headers: {
        Authorization: "Bearer test",
      },
    });
    expect(Object.keys(result.tools)).toEqual(["memory__read"]);
    expect(result.status).toEqual([
      {
        id: "memory",
        enabled: true,
        available: true,
        transportType: "http",
        target: "http://localhost:8787/mcp",
        toolCount: 1,
        toolNames: ["read"],
      },
    ]);

    await result.dispose();
    await result.dispose();
    expect(closeCount).toBe(1);
  });

  test("sanitizes MCP tool names to provider-safe function names", async () => {
    mock.module("@ai-sdk/mcp", () => ({
      createMCPClient: async () => ({
        tools: async () =>
          ({
            "browser.navigate": { description: "navigate" },
            "browser/navigate": { description: "navigate2" },
          }) as Record<string, unknown>,
        close: async () => {},
      }),
    }));

    const result = await initMCPTools({
      servers: [
        {
          id: "browsermcp",
          transport: {
            type: "http",
            url: "http://localhost:8787/mcp",
          },
        },
      ],
    });

    expect(Object.keys(result.tools)).toEqual([
      "browsermcp__browser_navigate",
      "browsermcp__browser_navigate_2",
    ]);
  });
});
