import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  loadMessageGatewayConfig,
  resolveMessageGatewayConfig,
} from "./config";

describe("message gateway config", () => {
  test("resolves defaults and env token override", () => {
    const resolved = resolveMessageGatewayConfig(
      {
        gateway: {
          auth: {
            bearerToken: "inline-token",
            bearerTokenEnv: "MG_TOKEN",
          },
        },
        channels: [
          {
            id: "telegram_main",
            type: "telegram",
            channelEndpoint: {
              port: 19001,
            },
          },
        ],
      },
      { MG_TOKEN: "env-token" },
    );

    expect(resolved.gateway.enabled).toBe(true);
    expect(resolved.gateway.inboundPath).toBe("/v1/message-gateway/inbound");
    expect(resolved.gateway.auth.bearerToken).toBe("env-token");
    expect(resolved.channels[0]?.channelEndpoint.host).toBe("127.0.0.1");
    expect(resolved.channels[0]?.channelEndpoint.healthPath).toBe("/healthz");
    expect(resolved.channels[0]?.channelEndpoint.invokePath).toBe("/rpc");
    expect(resolved.channels[0]?.channelEndpoint.startupTimeoutMs).toBe(10000);
  });

  test("throws when enabled but bearer token is missing", () => {
    expect(() =>
      resolveMessageGatewayConfig({
        gateway: {
          enabled: true,
        },
        channels: [],
      }),
    ).toThrow("Message gateway token is required");
  });

  test("load returns disabled config when file is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-message-gateway-config-missing-"));
    const resolved = await loadMessageGatewayConfig({ workspace });

    expect(resolved.gateway.enabled).toBe(false);
    expect(resolved.channels).toEqual([]);
  });

  test("load reads config file and validates duplicate channel ids", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-message-gateway-config-"));
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
            auth: {
              bearerToken: "abc",
            },
          },
          channels: [
            {
              id: "dup",
              type: "http",
              channelEndpoint: {
                port: 19002,
              },
            },
            {
              id: "dup",
              type: "telegram",
              channelEndpoint: {
                port: 19003,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(loadMessageGatewayConfig({ workspace })).rejects.toThrow("duplicated id");
  });
});
