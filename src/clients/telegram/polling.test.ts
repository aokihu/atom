import { describe, expect, test } from "bun:test";

import { nextBackoffMs, runTelegramPolling } from "./polling";
import type { TelegramBotApi } from "./bot_api";

describe("nextBackoffMs", () => {
  test("grows exponentially and caps", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1000)).toBe(2000);
    expect(nextBackoffMs(30000)).toBe(30000);
  });
});

describe("runTelegramPolling", () => {
  test("drops pending updates on startup and only handles fresh updates", async () => {
    const offsets: number[] = [];
    const handled: number[] = [];
    const controller = new AbortController();
    let callCount = 0;

    const api: TelegramBotApi = {
      async getUpdates(options) {
        offsets.push(options?.offset ?? 0);
        callCount += 1;
        if (callCount === 1) {
          return [{ update_id: 10 }];
        }
        if (callCount === 2) {
          return [];
        }
        if (callCount === 3) {
          return [{ update_id: 11, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "hi" } }];
        }
        return [];
      },
      async sendMessage() {},
    };

    await runTelegramPolling({
      api,
      signal: controller.signal,
      pollingIntervalMs: 0,
      longPollTimeoutSec: 1,
      dropPendingUpdatesOnStart: true,
      onUpdate: async (update) => {
        handled.push(update.update_id);
        controller.abort();
      },
      logger: { log() {}, warn() {} },
    });

    expect(handled).toEqual([11]);
    expect(offsets).toEqual([0, 11, 11]);
  });

  test("advances offset between polling rounds", async () => {
    const offsets: number[] = [];
    const controller = new AbortController();
    let callCount = 0;

    const api: TelegramBotApi = {
      async getUpdates(options) {
        offsets.push(options?.offset ?? 0);
        callCount += 1;
        if (callCount === 1) {
          return [{ update_id: 5, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "a" } }];
        }
        if (callCount === 2) {
          return [{ update_id: 6, message: { message_id: 2, chat: { id: 1, type: "private" }, text: "b" } }];
        }
        return [];
      },
      async sendMessage() {},
    };

    await runTelegramPolling({
      api,
      signal: controller.signal,
      pollingIntervalMs: 0,
      longPollTimeoutSec: 1,
      dropPendingUpdatesOnStart: false,
      onUpdate: async (update) => {
        if (update.update_id === 6) {
          controller.abort();
        }
      },
      logger: { log() {}, warn() {} },
    });

    expect(offsets).toEqual([0, 6]);
  });
});
