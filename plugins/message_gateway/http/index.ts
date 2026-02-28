import type {
  MessageGatewayInboundRequest,
  MessageGatewayParseInboundResult,
  ResolvedMessageGatewayChannelConfig,
} from "../../../src/types/message_gateway";
import { parseJsonEnv, startPluginServer } from "../shared/server";

const trimToUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const extractText = (body: Record<string, unknown>): string | undefined =>
  trimToUndefined(body.text) ??
  trimToUndefined(body.message) ??
  trimToUndefined(body.input);

const parseInbound = (request: MessageGatewayInboundRequest): MessageGatewayParseInboundResult => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return {
      accepted: true,
      messages: [],
    };
  }
  const body = request.body as Record<string, unknown>;
  const text = extractText(body);
  if (!text) {
    return {
      accepted: true,
      messages: [],
    };
  }

  const conversationId =
    trimToUndefined(body.conversationId) ??
    trimToUndefined(body.chatId) ??
    trimToUndefined(body.threadId) ??
    "http";
  const senderId =
    trimToUndefined(body.senderId) ??
    trimToUndefined(body.userId) ??
    trimToUndefined(body.from);

  return {
    accepted: true,
    messages: [
      {
        conversationId,
        senderId,
        text,
        metadata: {
          source: "http",
        },
      },
    ],
  };
};

const main = async () => {
  const channelConfig = parseJsonEnv<ResolvedMessageGatewayChannelConfig>(
    "ATOM_MESSAGE_GATEWAY_CHANNEL_CONFIG",
  );
  if (channelConfig.type !== "http") {
    throw new Error(`http plugin received unsupported channel type: ${channelConfig.type}`);
  }

  const server = startPluginServer({
    channelId: channelConfig.id,
    host: channelConfig.channelEndpoint.host,
    port: channelConfig.channelEndpoint.port,
    healthPath: channelConfig.channelEndpoint.healthPath,
    invokePath: channelConfig.channelEndpoint.invokePath,
    methods: {
      "channel.parseInbound": async (params) => {
        const request = params.request as MessageGatewayInboundRequest | undefined;
        if (!request || typeof request !== "object") {
          throw new Error("channel.parseInbound requires request");
        }
        return parseInbound(request);
      },
      "channel.deliver": async (params) => {
        const request = params.request as { conversationId?: unknown; text?: unknown } | undefined;
        const conversationId =
          request && typeof request === "object" ? trimToUndefined(request.conversationId) : undefined;
        const text = request && typeof request === "object" ? trimToUndefined(request.text) : undefined;
        if (conversationId && text) {
          console.log(`[message_gateway:${channelConfig.id}] deliver -> ${conversationId}: ${text}`);
        }
        return { delivered: true };
      },
      "channel.shutdown": async () => {
        await server.shutdown();
        server.dispose();
        queueMicrotask(() => process.exit(0));
        return { stopped: true };
      },
    },
  });

  console.log(
    `[message_gateway:${channelConfig.id}] listening on http://${server.host}:${server.port}`,
  );
};

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[message_gateway] http plugin failed: ${message}`);
  process.exit(1);
});
