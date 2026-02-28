import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildContextLogFilepath,
  buildContextLogPayload,
  buildContextLogTimestamp,
  saveContextLog,
} from "./context_log";

describe("context_log", () => {
  test("buildContextLogTimestamp uses yyyyMMddHHmmss format", () => {
    const token = buildContextLogTimestamp(new Date("2026-02-28T01:02:03.000Z"));
    expect(token).toBe("20260228010203");
  });

  test("buildContextLogFilepath points to workspace .agent/log", () => {
    const filepath = buildContextLogFilepath(
      "/tmp/ws",
      new Date("2026-02-28T01:02:03.000Z"),
    );
    expect(filepath).toContain("/tmp/ws/.agent/log/context_20260228010203.log");
  });

  test("saveContextLog writes context body to log file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-context-log-"));
    const content = "{\"runtime\":{\"workspace\":\"/tmp/ws\"}}";
    const now = new Date("2026-02-28T01:02:03.000Z");

    const filepath = await saveContextLog({
      workspace,
      contextBody: content,
      now,
    });

    expect(dirname(filepath)).toBe(join(workspace, ".agent", "log"));
    expect(await readFile(filepath, "utf8")).toBe(content);

    await rm(workspace, { recursive: true, force: true });
  });

  test("buildContextLogPayload serializes full context snapshot envelope", () => {
    const payload = buildContextLogPayload({
      contextResponse: {
        context: {
          version: 2.3,
          runtime: {
            round: 3,
            workspace: "/tmp/ws/",
            datetime: "2026-02-28T06:19:43.864Z",
            startup_at: 1,
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
            longterm: [],
          },
        } as any,
        injectedContext: {
          version: 2.3,
          runtime: {
            round: 3,
            workspace: "/tmp/ws/",
            datetime: "2026-02-28T06:19:43.864Z",
            startup_at: 1,
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
            longterm: [],
          },
        } as any,
        projectionDebug: {
          round: 3,
          rawCounts: {
            core: 0,
            working: 0,
            ephemeral: 0,
            longterm: 0,
          },
          injectedCounts: {
            core: 0,
            working: 0,
            ephemeral: 0,
            longterm: 0,
          },
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
      savedAt: new Date("2026-02-28T01:02:03.000Z"),
    });

    expect(payload).toContain("\"saved_at\": \"2026-02-28T01:02:03.000Z\"");
    expect(payload).toContain("\"injectedContext\"");
    expect(payload).toContain("\"projectionDebug\"");
  });

  test("buildContextLogPayload serializes context-lite envelope", () => {
    const payload = buildContextLogPayload({
      contextResponse: {
        modelContext: {
          version: 3,
          runtime: {
            round: 3,
            workspace: "/tmp/ws/",
            datetime: "2026-02-28T06:19:43.864Z",
            startup_at: 1,
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
            longterm: [],
          },
        } as any,
        meta: {
          rawContextBytes: 1024,
          modelContextBytes: 512,
          projectionDebug: {
            round: 3,
            rawCounts: {
              core: 0,
              working: 0,
              ephemeral: 0,
              longterm: 0,
            },
            injectedCounts: {
              core: 0,
              working: 0,
              ephemeral: 0,
              longterm: 0,
            },
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
      } as any,
      savedAt: new Date("2026-02-28T01:02:03.000Z"),
    });

    expect(payload).toContain("\"saved_at\": \"2026-02-28T01:02:03.000Z\"");
    expect(payload).toContain("\"modelContext\"");
    expect(payload).toContain("\"meta\"");
  });
});
