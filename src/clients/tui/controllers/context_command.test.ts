import { describe, expect, test } from "bun:test";
import { executeContextCommand } from "./context_command";

describe("context_command", () => {
  test("prefers context-lite endpoint when available", async () => {
    const events: string[] = [];
    let payload: unknown;

    const client = {
      async getAgentContextLite() {
        return {
          modelContext: {
            version: 3,
            runtime: {
              round: 1,
              workspace: "/tmp/ws/",
              datetime: "2026-02-28T00:00:00.000Z",
              startup_at: 1,
            },
            memory: {
              core: [],
              working: [],
              ephemeral: [],
              longterm: [],
            },
          },
          meta: {
            rawContextBytes: 100,
            modelContextBytes: 80,
          },
        };
      },
      async getAgentContext() {
        throw new Error("should not be called");
      },
    } as any;

    await executeContextCommand({
      client,
      withConnectionTracking: async (op) => await op(),
      formatJson: (value) => JSON.stringify(value),
      formatErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      callbacks: {
        onStart: () => events.push("start"),
        onSuccess: (body, context) => {
          events.push("success");
          payload = { body, context };
        },
        onError: () => events.push("error"),
        onFinally: () => events.push("finally"),
      },
    });

    expect(events).toEqual(["start", "success", "finally"]);
    expect(JSON.stringify(payload)).toContain("\"longterm\":[]");
  });

  test("falls back to legacy context endpoint when lite fails", async () => {
    const client = {
      async getAgentContextLite() {
        throw new Error("not available");
      },
      async getAgentContext() {
        return {
          context: {
            version: 3,
            runtime: {
              round: 1,
              workspace: "/tmp/ws/",
              datetime: "2026-02-28T00:00:00.000Z",
              startup_at: 1,
            },
            memory: {
              core: [],
              working: [],
              ephemeral: [],
              longterm: [],
            },
          },
        };
      },
    } as any;

    let body = "";
    await executeContextCommand({
      client,
      withConnectionTracking: async (op) => await op(),
      formatJson: (value) => JSON.stringify(value),
      formatErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      callbacks: {
        onStart: () => {},
        onSuccess: (nextBody) => {
          body = nextBody;
        },
        onError: () => {
          throw new Error("should not fail");
        },
        onFinally: () => {},
      },
    });

    expect(body).toContain("\"memory\"");
  });
});
