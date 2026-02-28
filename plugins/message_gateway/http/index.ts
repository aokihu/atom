import { HttpGatewayClient } from "../../../src/libs/channel";
import type { ResolvedMessageGatewayChannelConfig } from "../../../src/types/message_gateway";
import { parseJsonEnv, startPluginServer } from "../shared/server";
import { assertChannelSettingsObject, resolveSecret } from "../shared/config";

const trimToUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const extractText = (body: Record<string, unknown>): string | undefined =>
  trimToUndefined(body.text) ??
  trimToUndefined(body.message) ??
  trimToUndefined(body.input);

const ensurePath = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized.startsWith("/")) {
    throw new Error(`${label} must start with /`);
  }
  return normalized;
};

const main = async () => {
  const channelConfig = parseJsonEnv<ResolvedMessageGatewayChannelConfig>(
    "ATOM_MESSAGE_GATEWAY_CHANNEL_CONFIG",
  );
  if (channelConfig.type !== "http") {
    throw new Error(`http plugin received unsupported channel type: ${channelConfig.type}`);
  }

  const serverUrl = trimToUndefined(process.env.ATOM_MESSAGE_GATEWAY_SERVER_URL);
  if (!serverUrl) {
    throw new Error("ATOM_MESSAGE_GATEWAY_SERVER_URL is required");
  }

  const settings = assertChannelSettingsObject(channelConfig);
  const inboundPath = ensurePath(
    trimToUndefined(settings.inboundPath) ?? "/http/webhook",
    "http.inboundPath",
  );
  const authToken = resolveSecret(
    {
      envName: settings.authTokenEnv,
      inlineValue: settings.authToken,
      fieldLabel: "http.authToken",
      required: false,
    },
    process.env,
  );

  const serverClient = new HttpGatewayClient(serverUrl);

  const server = startPluginServer({
    channelId: channelConfig.id,
    host: channelConfig.channelEndpoint.host,
    port: channelConfig.channelEndpoint.port,
    healthPath: channelConfig.channelEndpoint.healthPath,
    invokePath: channelConfig.channelEndpoint.invokePath,
    methods: {
      "channel.shutdown": async () => {
        await server.shutdown();
        server.dispose();
        queueMicrotask(() => process.exit(0));
        return { stopped: true };
      },
    },
    extraFetchHandlers: [
      async (request, url) => {
        if (url.pathname !== inboundPath) {
          return undefined;
        }

        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        if (authToken) {
          const incoming = request.headers.get("authorization")?.trim();
          if (incoming !== `Bearer ${authToken}`) {
            return new Response("Unauthorized", { status: 401 });
          }
        }

        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {}

        const text = extractText(body);
        if (!text) {
          return new Response(
            JSON.stringify({ ok: true, accepted: false, reason: "no text" }),
            {
              status: 202,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }

        const conversationId =
          trimToUndefined(body.conversationId) ??
          trimToUndefined(body.chatId) ??
          trimToUndefined(body.threadId) ??
          "http";
        const senderId =
          trimToUndefined(body.senderId) ??
          trimToUndefined(body.userId) ??
          trimToUndefined(body.from) ??
          "unknown";

        const input = `[channel=${channelConfig.id} conversation=${conversationId} sender=${senderId}]\n${text}`;
        const created = await serverClient.createTask({
          type: "message_gateway.input",
          input,
        });

        return new Response(
          JSON.stringify({
            ok: true,
            accepted: true,
            taskId: created.taskId,
          }),
          {
            status: 202,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      },
    ],
  });

  console.log(
    `[message_gateway:${channelConfig.id}] listening on http://${server.host}:${server.port}${inboundPath}`,
  );
};

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[message_gateway] http plugin failed: ${message}`);
  process.exit(1);
});
