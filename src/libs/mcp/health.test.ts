import { describe, expect, test } from "bun:test";

import { createMCPHealthStatusProvider } from "./health";
import type { MCPServerStatus } from "./index";

const createStartupStatus = (): MCPServerStatus[] => [
  {
    id: "local",
    enabled: true,
    available: true,
    transportType: "stdio",
    target: "npx",
  },
  {
    id: "remote",
    enabled: true,
    available: false,
    transportType: "http",
    target: "http://127.0.0.1:8765/mcp",
    message: "startup failed",
  },
];

describe("createMCPHealthStatusProvider", () => {
  test("returns startup status when probeHttp is false", async () => {
    const provider = createMCPHealthStatusProvider({
      startupStatus: createStartupStatus(),
      fetchFn: async () => {
        throw new Error("should not fetch");
      },
    });

    const status = await provider({ probeHttp: false });
    expect(status.connected).toBe(1);
    expect(status.total).toBe(2);
    expect(status.servers[0]?.id).toBe("local");
    expect(status.servers[0]?.connected).toBe(true);
    expect(status.servers[1]?.id).toBe("remote");
    expect(status.servers[1]?.connected).toBe(false);
    expect(status.servers[1]?.message).toBe("startup failed");
  });

  test("probes http servers when probeHttp is true", async () => {
    const calls: string[] = [];
    const provider = createMCPHealthStatusProvider({
      startupStatus: createStartupStatus(),
      fetchFn: async (input) => {
        calls.push(String(input));
        return new Response("ok", { status: 204 });
      },
    });

    const status = await provider({ probeHttp: true });
    expect(calls).toEqual(["http://127.0.0.1:8765/mcp"]);
    expect(status.connected).toBe(2);
    expect(status.total).toBe(2);
    expect(status.servers[1]?.connected).toBe(true);
    expect(status.servers[1]?.message).toBeUndefined();
  });

  test("marks http probe as failed when server returns 5xx", async () => {
    const provider = createMCPHealthStatusProvider({
      startupStatus: createStartupStatus(),
      fetchFn: async () => new Response("boom", { status: 503 }),
    });

    const status = await provider({ probeHttp: true });
    expect(status.connected).toBe(1);
    expect(status.servers[1]?.connected).toBe(false);
  });

  test("stores error message when http probe throws", async () => {
    const provider = createMCPHealthStatusProvider({
      startupStatus: createStartupStatus(),
      fetchFn: async () => {
        throw new Error("dial failed");
      },
    });

    const status = await provider({ probeHttp: true });
    expect(status.connected).toBe(1);
    expect(status.servers[1]?.connected).toBe(false);
    expect(status.servers[1]?.message).toContain("dial failed");
  });
});
