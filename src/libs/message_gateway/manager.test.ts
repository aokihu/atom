import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MessageGatewayManager } from "./manager";

const runningManagers: MessageGatewayManager[] = [];

const getFreePort = (): number => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port ?? 0;
  server.stop();
  if (port <= 0) {
    throw new Error("failed to allocate test port");
  }
  return port;
};

afterEach(async () => {
  while (runningManagers.length > 0) {
    const manager = runningManagers.pop();
    if (manager) {
      await manager.stop();
    }
  }
});

describe("MessageGatewayManager", () => {
  test("starts configured channel process and reports running health", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const port = getFreePort();
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
          },
          channels: [
            {
              id: "http_ingress",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port,
              },
              settings: {
                inboundPath: "/http/webhook",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const manager = await MessageGatewayManager.create({
      workspace,
      includeChannels: ["http_ingress"],
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);

    manager.setServerUrl("http://127.0.0.1:8787");
    await manager.start();

    const health = manager.getHealthStatus();
    expect(health.configured).toBe(1);
    expect(health.running).toBe(1);
    expect(health.channels[0]?.id).toBe("http_ingress");
    expect(health.channels[0]?.running).toBe(true);
  });
});
