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

describe("HttpGatewayClient schedule APIs", () => {
  test("calls create/list/cancel schedule endpoints", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
      });

      if (String(input).endsWith("/v1/schedules") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              schedule: {
                scheduleId: "schedule-1",
                dedupeKey: "demo",
                taskInput: "hello",
                taskType: "scheduled.input",
                priority: 2,
                trigger: { mode: "delay", delaySeconds: 10 },
                nextRunAt: Date.now() + 1_000,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (String(input).endsWith("/v1/schedules") && init?.method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { items: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            scheduleId: "schedule-1",
            cancelled: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new HttpGatewayClient("http://127.0.0.1:8787");
    await client.createSchedule?.({
      dedupeKey: "demo",
      taskInput: "hello",
      trigger: { mode: "delay", delaySeconds: 10 },
    });
    await client.listSchedules?.();
    await client.cancelSchedule?.("schedule-1");

    expect(requests).toEqual([
      { url: "http://127.0.0.1:8787/v1/schedules", method: "POST" },
      { url: "http://127.0.0.1:8787/v1/schedules", method: "GET" },
      { url: "http://127.0.0.1:8787/v1/schedules/schedule-1", method: "DELETE" },
    ]);
  });
});
