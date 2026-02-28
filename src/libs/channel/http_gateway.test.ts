import { afterEach, describe, expect, test } from "bun:test";

import { startHttpGateway } from "./http_gateway";
import type { RuntimeGateway } from "./channel";

const createRuntime = (): RuntimeGateway => ({
  submitTask() {
    throw new Error("not implemented");
  },
  getTask() {
    throw new Error("not implemented");
  },
  getQueueStats() {
    return { size: 0 };
  },
  getAgentContext() {
    throw new Error("not implemented");
  },
  getAgentMessages() {
    throw new Error("not implemented");
  },
  memorySearch() {
    throw new Error("not implemented");
  },
  memoryGet() {
    throw new Error("not implemented");
  },
  memoryUpsert() {
    throw new Error("not implemented");
  },
  memoryUpdate() {
    throw new Error("not implemented");
  },
  memoryDelete() {
    throw new Error("not implemented");
  },
  memoryFeedback() {
    throw new Error("not implemented");
  },
  memoryTagResolve() {
    throw new Error("not implemented");
  },
  memoryStats() {
    throw new Error("not implemented");
  },
  memoryCompact() {
    throw new Error("not implemented");
  },
  memoryListRecent() {
    throw new Error("not implemented");
  },
  forceAbort() {
    return {
      abortedCurrent: false,
      clearedPendingCount: 0,
      timestamp: Date.now(),
    };
  },
});

const startedServers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (startedServers.length > 0) {
    startedServers.pop()?.stop();
  }
});

describe("startHttpGateway /healthz", () => {
  test("injects mcp payload and forwards probe flag", async () => {
    const probeFlags: boolean[] = [];
    const gateway = startHttpGateway({
      runtime: createRuntime(),
      host: "127.0.0.1",
      port: 0,
      appName: "atom",
      version: "test",
      startupAt: Date.now(),
      getMcpStatus: async (options) => {
        probeFlags.push(options?.probeHttp === true);
        return {
          connected: 1,
          total: 2,
          servers: [
            {
              id: "local",
              transport: "stdio",
              connected: true,
              testedAt: Date.now(),
            },
            {
              id: "remote",
              transport: "http",
              connected: false,
              message: "dial failed",
              testedAt: Date.now(),
            },
          ],
        };
      },
    });
    startedServers.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/healthz?probeMcpHttp=1`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.mcp.connected).toBe(1);
    expect(payload.data.mcp.total).toBe(2);
    expect(probeFlags).toEqual([true]);
  });

  test("keeps backward compatibility when mcp provider is missing", async () => {
    const gateway = startHttpGateway({
      runtime: createRuntime(),
      host: "127.0.0.1",
      port: 0,
      appName: "atom",
      version: "test",
      startupAt: Date.now(),
    });
    startedServers.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/healthz`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.mcp).toBeUndefined();
  });

  test("injects message gateway health payload when provider is present", async () => {
    const gateway = startHttpGateway({
      runtime: createRuntime(),
      host: "127.0.0.1",
      port: 0,
      appName: "atom",
      version: "test",
      startupAt: Date.now(),
      getMessageGatewayStatus: () => ({
        enabled: true,
        inboundPath: "/v1/message-gateway/inbound",
        configured: 2,
        running: 1,
        failed: 1,
        channels: [
          {
            id: "telegram_main",
            type: "telegram",
            enabled: true,
            running: true,
            endpoint: "http://127.0.0.1:19001",
          },
          {
            id: "http_ingress",
            type: "http",
            enabled: true,
            running: false,
            endpoint: "http://127.0.0.1:19002",
            error: "startup timeout",
          },
        ],
      }),
    });
    startedServers.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/healthz`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.messageGateway.enabled).toBe(true);
    expect(payload.data.messageGateway.channels.length).toBe(2);
  });
});
