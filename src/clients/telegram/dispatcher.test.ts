import { describe, expect, test } from "bun:test";

import type { GatewayClient } from "../../libs/channel/channel";
import type { TaskStatusResponse } from "../../types/http";
import { TaskStatus } from "../../types/task";
import {
  createTelegramUpdateDispatcher,
  executeTelegramTaskFlow,
} from "./dispatcher";
import type { TelegramUpdate } from "./bot_api";

const createUpdate = (patch: Partial<TelegramUpdate> = {}): TelegramUpdate => ({
  update_id: 1,
  message: {
    message_id: 1,
    chat: {
      id: 123,
      type: "private",
    },
    text: "hello",
  },
  ...patch,
});

const makeGatewayClient = (responses: TaskStatusResponse[]): GatewayClient => {
  let callIndex = 0;

  return {
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
          input: "hello",
          retries: 0,
          maxRetries: 1,
          createAt: Date.now(),
          cancellable: true,
        },
      };
    },
    async getTask() {
      const response = responses[Math.min(callIndex, responses.length - 1)];
      callIndex += 1;
      if (!response) {
        throw new Error("missing task response");
      }
      return response;
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
};

describe("executeTelegramTaskFlow", () => {
  test("returns final assistant summary", async () => {
    const client = makeGatewayClient([
      {
        task: {
          id: "task-1",
          type: "telegram.input",
          priority: 2,
          status: TaskStatus.Success,
          input: "hello",
          result: "done",
          retries: 0,
          maxRetries: 1,
          createAt: Date.now(),
          cancellable: true,
        },
      },
    ]);

    const summary = await executeTelegramTaskFlow({
      client,
      input: "hello",
      pollIntervalMs: 0,
    });

    expect(summary.kind).toBe("assistant_reply");
    expect(summary.statusNotice).toContain("Reply received");
  });
});

describe("createTelegramUpdateDispatcher", () => {
  test("ignores non-whitelisted chat", async () => {
    const sent: string[] = [];
    const dispatcher = createTelegramUpdateDispatcher({
      client: makeGatewayClient([]),
      allowedChatId: "999",
      pollIntervalMs: 0,
      sendText: async (_chatId, text) => {
        sent.push(text);
      },
    });

    await dispatcher(createUpdate());
    expect(sent).toEqual([]);
  });

  test("responds to /start and /help", async () => {
    const sent: string[] = [];
    const dispatcher = createTelegramUpdateDispatcher({
      client: makeGatewayClient([]),
      allowedChatId: "123",
      pollIntervalMs: 0,
      sendText: async (_chatId, text) => {
        sent.push(text);
      },
    });

    await dispatcher(createUpdate({ message: { ...createUpdate().message!, text: "/start" } }));
    await dispatcher(createUpdate({ message: { ...createUpdate().message!, text: "/help" } }));

    expect(sent[0]).toContain("Atom bot is ready");
    expect(sent[1]).toContain("Commands:");
  });

  test("runs task for plain text and sends failure summary", async () => {
    const sent: string[] = [];
    const dispatcher = createTelegramUpdateDispatcher({
      client: makeGatewayClient([
        {
          task: {
            id: "task-1",
            type: "telegram.input",
            priority: 2,
            status: TaskStatus.Failed,
            input: "hello",
            error: { message: "boom" },
            retries: 0,
            maxRetries: 1,
            createAt: Date.now(),
            cancellable: true,
          },
        },
      ]),
      allowedChatId: "123",
      pollIntervalMs: 0,
      sendText: async (_chatId, text) => {
        sent.push(text);
      },
    });

    await dispatcher(createUpdate({ message: { ...createUpdate().message!, text: "run this" } }));

    expect(sent).toEqual(["Task failed: boom"]);
  });
});
