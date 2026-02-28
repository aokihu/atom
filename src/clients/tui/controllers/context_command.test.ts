/**
 * Tests for TUI context command controller.
 *
 * Purpose:
 * - Validate success/failure callback sequencing.
 * - Protect context command behavior from regression during refactors.
 */

import { describe, expect, test } from "bun:test";
import { executeContextCommand } from "./context_command";

describe("executeContextCommand", () => {
  test("prefers context-lite endpoint when available", async () => {
    const calls: Array<{ type: string; value?: string }> = [];

    await executeContextCommand({
      client: {
        async getAgentContextLite() {
          return {
            modelContext: {
              version: 3,
              runtime: {
                round: 1,
                workspace: "/tmp/",
                datetime: "2026-02-26T00:00:00.000Z",
                startup_at: 1700000000000,
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
              modelContextBytes: 50,
              projectionDebug: {
                round: 1,
                rawCounts: { core: 0, working: 0, ephemeral: 0, longterm: 0 },
                injectedCounts: { core: 0, working: 0, ephemeral: 0, longterm: 0 },
                droppedByReason: {
                  working_status_terminal: 0,
                  threshold_decay: 0,
                  threshold_confidence: 0,
                  expired_by_round: 0,
                  over_max_items: 0,
                  invalid_block: 0,
                },
                droppedSamples: {},
              },
            },
          } as any;
        },
      } as any,
      withConnectionTracking: async (operation) => await operation(),
      formatJson: (value) => JSON.stringify(value),
      formatErrorMessage: (error) => String(error),
      callbacks: {
        onStart: () => calls.push({ type: "start" }),
        onSuccess: (body) => calls.push({ type: "success", value: body }),
        onError: (message) => calls.push({ type: "error", value: message }),
        onFinally: () => calls.push({ type: "finally" }),
      },
    });

    expect(calls.map((call) => call.type)).toEqual(["start", "success", "finally"]);
    const successBody = calls.find((call) => call.type === "success")?.value ?? "";
    expect(successBody).toContain("\"modelContext\"");
    expect(successBody).toContain("\"meta\"");
  });

  test("prints the whole context response for debugging (raw + injected + projectionDebug)", async () => {
    const calls: Array<{ type: string; value?: string }> = [];

    await executeContextCommand({
      client: {
        async getAgentContext() {
          return {
            context: {
              version: 2.3,
              runtime: {
                round: 1,
                workspace: "/tmp/",
                datetime: "2026-02-26T00:00:00.000Z",
                startup_at: 1700000000000,
              },
              memory: {
                core: [],
                working: [{ id: "raw-work" }],
                ephemeral: [],
                longterm: [],
              },
            } as any,
            injectedContext: {
              version: 2.3,
              runtime: {
                round: 1,
                workspace: "/tmp/",
                datetime: "2026-02-26T00:00:00.000Z",
                startup_at: 1700000000000,
              },
              memory: {
                core: [],
                working: [],
                ephemeral: [],
                longterm: [],
              },
            } as any,
            projectionDebug: {
              round: 1,
              rawCounts: { core: 0, working: 1, ephemeral: 0, longterm: 0 },
              injectedCounts: { core: 0, working: 0, ephemeral: 0, longterm: 0 },
              droppedByReason: {
                working_status_terminal: 1,
                threshold_decay: 0,
                threshold_confidence: 0,
                expired_by_round: 0,
                over_max_items: 0,
                invalid_block: 0,
              },
              droppedSamples: {},
            },
          };
        },
      } as any,
      withConnectionTracking: async (operation) => await operation(),
      formatJson: (value) => JSON.stringify(value),
      formatErrorMessage: (error) => String(error),
      callbacks: {
        onStart: () => calls.push({ type: "start" }),
        onSuccess: (body) => calls.push({ type: "success", value: body }),
        onError: (message) => calls.push({ type: "error", value: message }),
        onFinally: () => calls.push({ type: "finally" }),
      },
    });

    expect(calls.map((call) => call.type)).toEqual(["start", "success", "finally"]);
    const successBody = calls.find((call) => call.type === "success")?.value ?? "";
    expect(successBody).toContain("\"context\"");
    expect(successBody).toContain("\"injectedContext\"");
    expect(successBody).toContain("\"projectionDebug\"");
  });
});
