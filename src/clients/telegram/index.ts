import type { GatewayClient } from "../../libs/channel/channel";
import type { ResolvedTelegramConfig } from "../../libs/agent/config";
import { createTelegramBotApi } from "./bot_api";
import { createTelegramUpdateDispatcher } from "./dispatcher";
import { escapeMarkdownV2 } from "./markdown_v2";
import { splitTelegramMessage } from "./message_split";
import { runTelegramPolling } from "./polling";

export type StartTelegramClientOptions = {
  client: GatewayClient;
  config: ResolvedTelegramConfig;
  logger?: Pick<Console, "log" | "warn">;
  fetchImpl?: typeof fetch;
};

const normalizeOutgoingText = (
  text: string,
  parseMode: ResolvedTelegramConfig["message"]["parseMode"],
): string => {
  const normalized = text.length > 0 ? text : "(empty result)";
  if (parseMode === "MarkdownV2") {
    return escapeMarkdownV2(normalized);
  }
  return normalized;
};

const createStopSignal = (): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();

  const onSignal = (signal: NodeJS.Signals) => {
    console.log(`[telegram] received ${signal}, stopping polling...`);
    controller.abort();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
};

export const startTelegramClient = async (
  options: StartTelegramClientOptions,
): Promise<void> => {
  const logger = options.logger ?? console;
  const { config } = options;

  if (config.transport.type === "webhook") {
    throw new Error(
      "telegram transport webhook is reserved but not implemented yet. Use transport.type=polling",
    );
  }

  const api = createTelegramBotApi({
    botToken: config.botToken,
    fetchImpl: options.fetchImpl,
  });

  const sendText = async (chatId: string, text: string): Promise<void> => {
    const outgoingText = normalizeOutgoingText(text, config.message.parseMode);
    const chunks = splitTelegramMessage(outgoingText, config.message.chunkSize);
    const parseMode = config.message.parseMode === "MarkdownV2" ? "MarkdownV2" : undefined;
    for (const chunk of chunks) {
      await api.sendMessage({
        chatId,
        text: chunk,
        parseMode,
      });
    }
  };

  const dispatchUpdate = createTelegramUpdateDispatcher({
    client: options.client,
    allowedChatId: config.allowedChatId,
    pollIntervalMs: config.transport.pollingIntervalMs,
    sendText,
  });

  logger.log(
    `[telegram] transport=${config.transport.type} | allowed_chat_id=${config.allowedChatId} | parse_mode=${config.message.parseMode}`,
  );
  logger.log(
    `[telegram] polling_interval_ms=${config.transport.pollingIntervalMs} | long_poll_timeout_sec=${config.transport.longPollTimeoutSec} | drop_pending_updates_on_start=${config.transport.dropPendingUpdatesOnStart}`,
  );

  const stopSignal = createStopSignal();
  try {
    logger.log("[telegram] polling loop started");
    await runTelegramPolling({
      api,
      signal: stopSignal.signal,
      pollingIntervalMs: config.transport.pollingIntervalMs,
      longPollTimeoutSec: config.transport.longPollTimeoutSec,
      dropPendingUpdatesOnStart: config.transport.dropPendingUpdatesOnStart,
      onUpdate: dispatchUpdate,
      logger,
    });
    logger.log("[telegram] polling loop stopped");
  } finally {
    stopSignal.dispose();
  }
};
