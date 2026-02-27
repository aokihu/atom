import { describe, expect, test } from "bun:test";

import type { GatewayClient } from "../../libs/channel/channel";
import { TaskStatus } from "../../types/task";
import { startTelegramClient } from "./index";

const gatewayClient: GatewayClient = {
  async getHealth() {
    return {
      name: "atom",
      version: "test",
      startupAt: Date.now(),
      queue: { size: 0 },
    };
  },
  async createTask() {
    return {
      taskId: "task-1",
      task: {
        id: "task-1",
        type: "telegram.input",
        priority: 2,
        status: TaskStatus.Pending,
        input: "hi",
        retries: 0,
        maxRetries: 1,
        createAt: Date.now(),
      },
    };
  },
  async getTask() {
    throw new Error("not implemented");
  },
  async getAgentContext() {
    throw new Error("not implemented");
  },
  async getAgentMessages() {
    throw new Error("not implemented");
  },
  async forceAbort() {
    return {
      abortedCurrent: false,
      clearedPendingCount: 0,
      timestamp: Date.now(),
    };
  },
};

describe("startTelegramClient", () => {
  test("throws when webhook transport is requested", async () => {
    await expect(
      startTelegramClient({
        client: gatewayClient,
        config: {
          botToken: "token",
          allowedChatId: "123",
          transport: {
            type: "webhook",
            pollingIntervalMs: 1000,
            longPollTimeoutSec: 30,
            dropPendingUpdatesOnStart: true,
          },
          message: {
            parseMode: "MarkdownV2",
            chunkSize: 3500,
          },
        },
        logger: { log() {}, warn() {} },
      }),
    ).rejects.toThrow("webhook is reserved but not implemented");
  });
});
