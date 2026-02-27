import { sleep } from "bun";

import type { GatewayClient } from "../../libs/channel/channel";
import type { CompletedTaskSummary } from "../shared/flows/task_flow";
import { executePolledTask } from "../shared/flows/task_polling";
import { summarizeCompletedTask } from "../shared/flows/task_flow";
import type { TelegramUpdate } from "./bot_api";

export type ExecuteTelegramTaskFlowOptions = {
  client: GatewayClient;
  input: string;
  pollIntervalMs: number;
  sleepFn?: (ms: number) => Promise<void>;
};

export const executeTelegramTaskFlow = async (
  options: ExecuteTelegramTaskFlowOptions,
): Promise<CompletedTaskSummary> => {
  const sleepFn = options.sleepFn ?? sleep;
  const result = await executePolledTask({
    client: options.client,
    taskType: "telegram.input",
    taskInput: options.input,
    pollIntervalMs: options.pollIntervalMs,
    sleepFn,
  });
  return summarizeCompletedTask(result.task);
};

export type TelegramUpdateDispatcherOptions = {
  client: GatewayClient;
  allowedChatId: string;
  pollIntervalMs: number;
  sendText: (chatId: string, text: string) => Promise<void>;
};

const extractCommand = (text: string): string | undefined => {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase();
};

const buildHelpText = (): string =>
  [
    "Atom Telegram channel",
    "",
    "Commands:",
    "/start - show welcome message",
    "/help - show this help",
    "",
    "Send any other text to start a task.",
  ].join("\n");

const summarizeForTelegram = (summary: CompletedTaskSummary): string => {
  if (summary.kind === "assistant_reply") {
    return summary.replyText;
  }

  return summary.statusNotice;
};

export const createTelegramUpdateDispatcher = (
  options: TelegramUpdateDispatcherOptions,
): ((update: TelegramUpdate) => Promise<void>) => {
  return async (update: TelegramUpdate): Promise<void> => {
    const message = update.message;
    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    if (chatId !== options.allowedChatId) {
      return;
    }

    if (typeof message.text !== "string" || message.text.trim() === "") {
      await options.sendText(chatId, "Only text messages are supported.");
      return;
    }

    const text = message.text.trim();
    const command = extractCommand(text);
    if (command === "start") {
      await options.sendText(chatId, "Atom bot is ready. Send a message to start a task.");
      return;
    }
    if (command === "help") {
      await options.sendText(chatId, buildHelpText());
      return;
    }

    const summary = await executeTelegramTaskFlow({
      client: options.client,
      input: text,
      pollIntervalMs: options.pollIntervalMs,
    });
    await options.sendText(chatId, summarizeForTelegram(summary));
  };
};
