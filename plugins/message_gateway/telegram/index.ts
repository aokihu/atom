import type {
  MessageGatewayDeliverResult,
  MessageGatewayInboundRequest,
  MessageGatewayParseInboundResult,
  ResolvedMessageGatewayChannelConfig,
} from "../../../src/types/message_gateway";
import { createTelegramBotApi } from "../../../src/clients/telegram/bot_api";
import { escapeMarkdownV2 } from "../../../src/clients/telegram/markdown_v2";
import { splitTelegramMessage } from "../../../src/clients/telegram/message_split";
import { assertChannelSettingsObject, resolveSecret, type MessageGatewayGlobalPluginConfig } from "../shared/config";
import { parseJsonEnv, startPluginServer } from "../shared/server";

type TelegramPluginSettings = {
  allowedChatId: string;
  botToken: string;
  webhookPublicBaseUrl: string;
  webhookSecretToken?: string;
  dropPendingUpdatesOnStart: boolean;
  parseMode: "MarkdownV2" | "plain";
  chunkSize: number;
};

type TelegramUpdatePayload = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: {
      id?: number;
      type?: string;
    };
    from?: {
      id?: number;
    };
  };
};

const trimToUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const ensureNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const resolvePluginSettings = (channel: ResolvedMessageGatewayChannelConfig): TelegramPluginSettings => {
  const settings = assertChannelSettingsObject(channel);
  const allowedChatId = ensureNonEmptyString(settings.allowedChatId, "telegram.allowedChatId");
  const botToken = resolveSecret({
    envName: settings.botTokenEnv,
    inlineValue: settings.botToken,
    fieldLabel: "telegram.botToken",
  }) as string;
  const webhookPublicBaseUrl = ensureNonEmptyString(
    settings.webhookPublicBaseUrl,
    "telegram.webhookPublicBaseUrl",
  );
  const webhookSecretToken = resolveSecret(
    {
      envName: settings.webhookSecretTokenEnv,
      inlineValue: settings.webhookSecretToken,
      fieldLabel: "telegram.webhookSecretToken",
      required: false,
    },
    process.env,
  );

  const parseModeRaw = trimToUndefined(settings.parseMode) ?? "MarkdownV2";
  const parseMode = parseModeRaw === "plain" ? "plain" : "MarkdownV2";
  const chunkSizeRaw =
    typeof settings.chunkSize === "number" && Number.isInteger(settings.chunkSize)
      ? settings.chunkSize
      : 3500;
  if (chunkSizeRaw < 1 || chunkSizeRaw > 4096) {
    throw new Error("telegram.chunkSize must be in range 1..4096");
  }

  return {
    allowedChatId,
    botToken,
    webhookPublicBaseUrl: normalizeBaseUrl(webhookPublicBaseUrl),
    webhookSecretToken: webhookSecretToken?.trim(),
    dropPendingUpdatesOnStart: settings.dropPendingUpdatesOnStart !== false,
    parseMode,
    chunkSize: chunkSizeRaw,
  };
};

const requestTelegramApi = async (
  botToken: string,
  endpoint: "setWebhook" | "deleteWebhook",
  payload: Record<string, unknown>,
): Promise<void> => {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram ${endpoint} returned invalid JSON`);
  }

  if (typeof result !== "object" || result === null || !("ok" in result)) {
    throw new Error(`Telegram ${endpoint} returned invalid payload`);
  }
  const ok = (result as { ok?: unknown }).ok;
  if (ok !== true) {
    const descriptionRaw = (result as { description?: unknown }).description;
    const description = typeof descriptionRaw === "string" ? descriptionRaw : "unknown error";
    throw new Error(`Telegram ${endpoint} failed: ${description}`);
  }
};

const buildWebhookUrl = (
  settings: TelegramPluginSettings,
  globalConfig: MessageGatewayGlobalPluginConfig,
  channelId: string,
): string => {
  const url = new URL(globalConfig.inboundPath, `${settings.webhookPublicBaseUrl}/`);
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("token", globalConfig.bearerToken);
  return url.toString();
};

const extractCommand = (text: string): string | undefined => {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase();
};

const buildHelpText = (): string =>
  [
    "Atom Message Gateway (Telegram)",
    "",
    "Commands:",
    "/start - show welcome message",
    "/help - show this help",
    "",
    "Send any other text to start a task.",
  ].join("\n");

const normalizeOutgoingText = (
  text: string,
  parseMode: TelegramPluginSettings["parseMode"],
): string => {
  const normalized = text.length > 0 ? text : "(empty result)";
  if (parseMode === "MarkdownV2") {
    return escapeMarkdownV2(normalized);
  }
  return normalized;
};

const parseTelegramInbound = (
  requestPayload: MessageGatewayInboundRequest,
  settings: TelegramPluginSettings,
): MessageGatewayParseInboundResult => {
  if (settings.webhookSecretToken) {
    const incomingSecret = trimToUndefined(
      requestPayload.headers["x-telegram-bot-api-secret-token"],
    );
    if (incomingSecret !== settings.webhookSecretToken) {
      return {
        accepted: false,
        messages: [],
      };
    }
  }

  const body = requestPayload.body as TelegramUpdatePayload | undefined;
  if (!body || typeof body !== "object") {
    return {
      accepted: true,
      messages: [],
    };
  }
  const message = body.message;
  if (!message || typeof message !== "object") {
    return {
      accepted: true,
      messages: [],
    };
  }

  const chatId = String(message.chat?.id ?? "");
  if (chatId !== settings.allowedChatId) {
    return {
      accepted: true,
      messages: [],
    };
  }

  const text = trimToUndefined(message.text);
  if (!text) {
    return {
      accepted: true,
      messages: [],
      immediateResponses: [
        {
          conversationId: chatId,
          text: "Only text messages are supported.",
        },
      ],
    };
  }

  const command = extractCommand(text);
  if (command === "start") {
    return {
      accepted: true,
      messages: [],
      immediateResponses: [
        {
          conversationId: chatId,
          text: "Atom bot is ready. Send a message to start a task.",
        },
      ],
    };
  }

  if (command === "help") {
    return {
      accepted: true,
      messages: [],
      immediateResponses: [
        {
          conversationId: chatId,
          text: buildHelpText(),
        },
      ],
    };
  }

  return {
    accepted: true,
    messages: [
      {
        messageId: typeof message.message_id === "number" ? String(message.message_id) : undefined,
        conversationId: chatId,
        senderId: typeof message.from?.id === "number" ? String(message.from.id) : undefined,
        text,
        metadata: {
          updateId: body.update_id,
          chatType: message.chat?.type,
        },
      },
    ],
  };
};

const main = async () => {
  const channelConfig = parseJsonEnv<ResolvedMessageGatewayChannelConfig>(
    "ATOM_MESSAGE_GATEWAY_CHANNEL_CONFIG",
  );
  const globalConfig = parseJsonEnv<MessageGatewayGlobalPluginConfig>(
    "ATOM_MESSAGE_GATEWAY_GLOBAL_CONFIG",
  );
  if (channelConfig.type !== "telegram") {
    throw new Error(`telegram plugin received unsupported channel type: ${channelConfig.type}`);
  }

  const settings = resolvePluginSettings(channelConfig);
  const api = createTelegramBotApi({
    botToken: settings.botToken,
  });

  const webhookUrl = buildWebhookUrl(settings, globalConfig, channelConfig.id);

  const gracefulShutdown = async (
    server: ReturnType<typeof startPluginServer>,
    reason: string,
  ) => {
    console.log(`[message_gateway:${channelConfig.id}] shutting down (${reason})...`);
    try {
      await requestTelegramApi(settings.botToken, "deleteWebhook", {
        drop_pending_updates: settings.dropPendingUpdatesOnStart,
      });
    } catch (error) {
      console.warn(
        `[message_gateway:${channelConfig.id}] deleteWebhook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await server.shutdown();
    server.dispose();
  };

  const server = startPluginServer({
    channelId: channelConfig.id,
    host: channelConfig.channelEndpoint.host,
    port: channelConfig.channelEndpoint.port,
    healthPath: channelConfig.channelEndpoint.healthPath,
    invokePath: channelConfig.channelEndpoint.invokePath,
    captureSignals: false,
    methods: {
      "channel.parseInbound": async (params) => {
        const request = params.request as MessageGatewayInboundRequest | undefined;
        if (!request || typeof request !== "object") {
          throw new Error("channel.parseInbound requires request");
        }
        return parseTelegramInbound(request, settings);
      },
      "channel.deliver": async (params) => {
        const request = params.request as { conversationId?: unknown; text?: unknown } | undefined;
        if (!request || typeof request !== "object") {
          throw new Error("channel.deliver requires request");
        }
        const conversationId = ensureNonEmptyString(request.conversationId, "conversationId");
        const text = ensureNonEmptyString(request.text, "text");
        const outgoingText = normalizeOutgoingText(text, settings.parseMode);
        const parseMode = settings.parseMode === "MarkdownV2" ? "MarkdownV2" : undefined;
        const chunks = splitTelegramMessage(outgoingText, settings.chunkSize);
        for (const chunk of chunks) {
          await api.sendMessage({
            chatId: conversationId,
            text: chunk,
            parseMode,
          });
        }
        return { delivered: true } satisfies MessageGatewayDeliverResult;
      },
      "channel.shutdown": async () => {
        await gracefulShutdown(server, "rpc shutdown");
        queueMicrotask(() => process.exit(0));
        return { stopped: true };
      },
    },
  });

  const onSignal = (signal: NodeJS.Signals) => {
    void gracefulShutdown(server, signal).finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await requestTelegramApi(settings.botToken, "setWebhook", {
    url: webhookUrl,
    ...(settings.webhookSecretToken
      ? { secret_token: settings.webhookSecretToken }
      : {}),
    drop_pending_updates: settings.dropPendingUpdatesOnStart,
  });

  console.log(
    `[message_gateway:${channelConfig.id}] webhook registered at ${webhookUrl}`,
  );
};

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[message_gateway] telegram plugin failed: ${message}`);
  process.exit(1);
});
