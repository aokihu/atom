import { afterEach, describe, expect, test } from "bun:test";

import { HttpGatewayClient } from "./http_client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HttpGatewayClient.getHealth", () => {
  test("sends probeMcpHttp query when probing is requested", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            name: "atom",
            version: "test",
            startupAt: Date.now(),
            queue: { size: 0 },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = new HttpGatewayClient("http://127.0.0.1:8787");
    await client.getHealth({ probeMcpHttp: true });

    expect(urls).toEqual(["http://127.0.0.1:8787/healthz?probeMcpHttp=1"]);
  });

  test("calls /healthz without query by default", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            name: "atom",
            version: "test",
            startupAt: Date.now(),
            queue: { size: 0 },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = new HttpGatewayClient("http://127.0.0.1:8787");
    await client.getHealth();

    expect(urls).toEqual(["http://127.0.0.1:8787/healthz"]);
  });
});
