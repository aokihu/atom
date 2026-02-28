import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  test("does not start any channel when selector is omitted", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const telegramPort = getFreePort();
    const httpPort = getFreePort();
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
          },
          channels: [
            {
              id: "telegram_main",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port: telegramPort,
              },
              settings: {
                inboundPath: "/telegram/webhook",
              },
            },
            {
              id: "http_ingress",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port: httpPort,
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
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);

    manager.setServerUrl("http://127.0.0.1:8787");
    await manager.start();

    const health = manager.getHealthStatus();
    expect(health.configured).toBe(0);
    expect(health.running).toBe(0);
    expect(health.channels).toHaveLength(0);
  });

  test("starts selected channels from --message-gateway selector", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const telegramPort = getFreePort();
    const httpPort = getFreePort();
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
          },
          channels: [
            {
              id: "telegram_main",
              type: "http",
              enabled: false,
              channelEndpoint: {
                host: "127.0.0.1",
                port: telegramPort,
              },
              settings: {
                inboundPath: "/telegram/webhook",
              },
            },
            {
              id: "http_ingress",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port: httpPort,
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
      messageGatewaySelector: "telegram_main,!wechat,http_ingress",
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);

    manager.setServerUrl("http://127.0.0.1:8787");
    await manager.start();

    const health = manager.getHealthStatus();
    expect(health.configured).toBe(2);
    expect(health.running).toBe(2);
    expect(health.channels.map((channel) => channel.id)).toEqual([
      "telegram_main",
      "http_ingress",
    ]);

    const telegramLogDir = join(workspace, ".agent", "message-gateway", "telegram_main");
    const httpLogDir = join(workspace, ".agent", "message-gateway", "http_ingress");
    const telegramLogFiles = await readdir(telegramLogDir);
    const httpLogFiles = await readdir(httpLogDir);
    expect(telegramLogFiles.length).toBeGreaterThan(0);
    expect(httpLogFiles.length).toBeGreaterThan(0);

    const telegramLogContent = await readFile(
      join(telegramLogDir, telegramLogFiles[0] ?? ""),
      "utf8",
    );
    expect(telegramLogContent).toContain("channel=telegram_main");
  });

  test("starts all enabled channels when --message-gateway=all", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const channelOnePort = getFreePort();
    const channelTwoPort = getFreePort();
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
          },
          channels: [
            {
              id: "telegram_main",
              type: "http",
              enabled: false,
              channelEndpoint: {
                host: "127.0.0.1",
                port: channelOnePort,
              },
              settings: {
                inboundPath: "/telegram/webhook",
              },
            },
            {
              id: "http_ingress",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port: channelTwoPort,
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
      messageGatewaySelector: "all",
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);

    manager.setServerUrl("http://127.0.0.1:8787");
    await manager.start();

    const health = manager.getHealthStatus();
    expect(health.configured).toBe(1);
    expect(health.running).toBe(1);
    expect(health.channels.map((channel) => channel.id)).toEqual(["http_ingress"]);
  });

  test("supports exclusion-only selector against default enabled channels", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const telegramPort = getFreePort();
    const httpPort = getFreePort();
    const wechatPort = getFreePort();
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
          },
          channels: [
            {
              id: "telegram_main",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port: telegramPort,
              },
              settings: {
                inboundPath: "/telegram/webhook",
              },
            },
            {
              id: "wechat",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port: wechatPort,
              },
              settings: {
                inboundPath: "/wechat/webhook",
              },
            },
            {
              id: "http_ingress",
              type: "http",
              enabled: false,
              channelEndpoint: {
                host: "127.0.0.1",
                port: httpPort,
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
      messageGatewaySelector: "!wechat",
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);

    manager.setServerUrl("http://127.0.0.1:8787");
    await manager.start();

    const health = manager.getHealthStatus();
    expect(health.configured).toBe(1);
    expect(health.running).toBe(1);
    expect(health.channels.map((channel) => channel.id)).toEqual(["telegram_main"]);
  });

  test("loads workspace .env and injects *_env secrets into plugin process", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const channelPort = getFreePort();

    await writeFile(join(workspace, ".env"), "HTTP_CHANNEL_TOKEN=env-token-123\n", "utf8");
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
                port: channelPort,
              },
              settings: {
                inboundPath: "/http/webhook",
                authTokenEnv: "HTTP_CHANNEL_TOKEN",
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
      messageGatewaySelector: "all",
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);

    manager.setServerUrl("http://127.0.0.1:8787");
    await manager.start();

    const unauthorized = await fetch(`http://127.0.0.1:${channelPort}/http/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(unauthorized.status).toBe(401);
  });
});
