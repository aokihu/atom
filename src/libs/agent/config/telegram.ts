import type {
  AgentConfig,
  TelegramMessageParseMode,
  TelegramTransportType,
} from "../../../types/agent";

export type ResolvedTelegramConfig = {
  botToken: string;
  allowedChatId: string;
  transport: {
    type: TelegramTransportType;
    pollingIntervalMs: number;
    longPollTimeoutSec: number;
    dropPendingUpdatesOnStart: boolean;
    webhookPath?: string;
    webhookSecretToken?: string;
  };
  message: {
    parseMode: TelegramMessageParseMode;
    chunkSize: number;
  };
};

export const DEFAULT_TELEGRAM_POLLING_INTERVAL_MS = 1000;
export const DEFAULT_TELEGRAM_LONG_POLL_TIMEOUT_SEC = 30;
export const DEFAULT_TELEGRAM_DROP_PENDING_UPDATES_ON_START = true;
export const DEFAULT_TELEGRAM_PARSE_MODE: TelegramMessageParseMode = "MarkdownV2";
export const DEFAULT_TELEGRAM_MESSAGE_CHUNK_SIZE = 3500;

const trimToUndefined = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

export const resolveTelegramConfig = (
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTelegramConfig | undefined => {
  const telegram = config.telegram;
  if (!telegram) {
    return undefined;
  }

  const allowedChatId = trimToUndefined(telegram.allowedChatId);
  if (!allowedChatId) {
    throw new Error("telegram.allowedChatId must be a non-empty string");
  }

  const resolvedBotToken = trimToUndefined(env.TELEGRAM_BOT_TOKEN) ?? trimToUndefined(telegram.botToken);
  if (!resolvedBotToken) {
    throw new Error(
      "Telegram bot token is required. Set telegram.botToken or TELEGRAM_BOT_TOKEN",
    );
  }

  const transportType = telegram.transport?.type ?? "polling";
  const parseMode = telegram.message?.parseMode ?? DEFAULT_TELEGRAM_PARSE_MODE;

  return {
    botToken: resolvedBotToken,
    allowedChatId,
    transport: {
      type: transportType,
      pollingIntervalMs:
        telegram.transport?.pollingIntervalMs ?? DEFAULT_TELEGRAM_POLLING_INTERVAL_MS,
      longPollTimeoutSec:
        telegram.transport?.longPollTimeoutSec ?? DEFAULT_TELEGRAM_LONG_POLL_TIMEOUT_SEC,
      dropPendingUpdatesOnStart:
        telegram.transport?.dropPendingUpdatesOnStart ??
        DEFAULT_TELEGRAM_DROP_PENDING_UPDATES_ON_START,
      webhookPath: trimToUndefined(telegram.transport?.webhookPath),
      webhookSecretToken: trimToUndefined(telegram.transport?.webhookSecretToken),
    },
    message: {
      parseMode,
      chunkSize:
        telegram.message?.chunkSize ?? DEFAULT_TELEGRAM_MESSAGE_CHUNK_SIZE,
    },
  };
};
