import { sleep } from "bun";
import { randomUUID } from "node:crypto";

import type { RuntimeGateway } from "../channel/channel";
import type {
  MessageGatewayDeliverRequest,
  MessageGatewayDeliverResult,
  MessageGatewayHealthStatus,
  MessageGatewayInboundRequest,
  MessageGatewayParseInboundResult,
  ResolvedMessageGatewayChannelConfig,
  ResolvedMessageGatewayConfig,
} from "../../types/message_gateway";
import { TaskStatus } from "../../types/task";
import { summarizeCompletedTask } from "../../clients/shared/flows/task_flow";
import { loadMessageGatewayConfig } from "./config";
import { resolveMessageGatewayPluginEntry } from "./registry";

type Logger = Pick<Console, "log" | "warn">;

type PluginRpcOk<T> = {
  ok: true;
  result: T;
};

type PluginRpcError = {
  ok: false;
  error: string;
};

type PluginRpcResponse<T> = PluginRpcOk<T> | PluginRpcError;

type ChannelRuntimeState = {
  config: ResolvedMessageGatewayChannelConfig;
  endpointBaseUrl: string;
  process?: ReturnType<typeof Bun.spawn>;
  running: boolean;
  error?: string;
  pid?: number;
};

export type CreateMessageGatewayManagerOptions = {
  workspace: string;
  runtime: RuntimeGateway;
  includeChannels?: string[];
  configPath?: string;
  logger?: Logger;
};

const normalizeHeaderMap = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
};

const parseBearerToken = (headerValue: string | null): string | undefined => {
  if (!headerValue) return undefined;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ensureOk = async (response: Response, context: string): Promise<unknown> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${context}: invalid JSON response`);
  }

  if (typeof payload !== "object" || payload === null || !("ok" in payload)) {
    throw new Error(`${context}: invalid response payload`);
  }

  const data = payload as PluginRpcResponse<unknown>;
  if (!response.ok || data.ok === false) {
    const message = data.ok === false ? data.error : response.statusText;
    throw new Error(`${context}: ${message}`);
  }
  return data.result;
};

const isTaskRunning = (status: TaskStatus): boolean =>
  status === TaskStatus.Pending || status === TaskStatus.Running;

export class MessageGatewayManager {
  readonly inboundPath: string;
  private readonly logger: Logger;
  private readonly includeChannels: Set<string> | null;
  private readonly states = new Map<string, ChannelRuntimeState>();
  private stopping = false;

  constructor(
    private readonly config: ResolvedMessageGatewayConfig,
    private readonly runtime: RuntimeGateway,
    options?: {
      includeChannels?: string[];
      logger?: Logger;
    },
  ) {
    this.logger = options?.logger ?? console;
    this.includeChannels =
      options?.includeChannels && options.includeChannels.length > 0
        ? new Set(options.includeChannels)
        : null;
    this.inboundPath = config.gateway.inboundPath;
  }

  static async create(
    options: CreateMessageGatewayManagerOptions,
  ): Promise<MessageGatewayManager> {
    const config = await loadMessageGatewayConfig({
      workspace: options.workspace,
      configPath: options.configPath,
    });
    return new MessageGatewayManager(config, options.runtime, {
      includeChannels: options.includeChannels,
      logger: options.logger,
    });
  }

  get enabled(): boolean {
    return this.config.gateway.enabled;
  }

  getHealthStatus(): MessageGatewayHealthStatus {
    const channels = [...this.states.values()].map((state) => ({
      id: state.config.id,
      type: state.config.type,
      enabled: state.config.enabled,
      running: state.running,
      endpoint: state.endpointBaseUrl,
      pid: state.pid,
      error: state.error,
    }));
    const configured = channels.length;
    const running = channels.filter((channel) => channel.running).length;
    const failed = channels.filter((channel) => !channel.running).length;

    return {
      enabled: this.enabled,
      inboundPath: this.inboundPath,
      configured,
      running,
      failed,
      channels,
    };
  }

  private isChannelSelected(channelId: string): boolean {
    if (!this.includeChannels) return true;
    return this.includeChannels.has(channelId);
  }

  private getSelectedChannels(): ResolvedMessageGatewayChannelConfig[] {
    const enabledChannels = this.config.channels.filter((channel) => channel.enabled);
    const selectedChannels = enabledChannels.filter((channel) =>
      this.isChannelSelected(channel.id),
    );

    if (this.includeChannels) {
      for (const channelId of this.includeChannels) {
        if (!enabledChannels.some((channel) => channel.id === channelId)) {
          this.logger.warn(`[message_gateway] --channels ignored unknown id: ${channelId}`);
        }
      }
    }

    return selectedChannels;
  }

  private registerChannelState(channel: ResolvedMessageGatewayChannelConfig): ChannelRuntimeState {
    const endpointBaseUrl = `http://${channel.channelEndpoint.host}:${channel.channelEndpoint.port}`;
    const state: ChannelRuntimeState = {
      config: channel,
      endpointBaseUrl,
      running: false,
    };
    this.states.set(channel.id, state);
    return state;
  }

  private async waitForChannelHealth(state: ChannelRuntimeState): Promise<void> {
    const healthUrl = `${state.endpointBaseUrl}${state.config.channelEndpoint.healthPath}`;
    const deadline = Date.now() + state.config.channelEndpoint.startupTimeoutMs;
    let lastError = "health check timed out";

    while (Date.now() <= deadline) {
      try {
        const response = await fetch(healthUrl);
        if (response.ok) {
          state.running = true;
          state.error = undefined;
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = toErrorMessage(error);
      }

      await sleep(200);
    }

    throw new Error(lastError);
  }

  private attachProcessLifecycleLogs(state: ChannelRuntimeState): void {
    const process = state.process;
    if (!process) return;

    const pump = async (
      stream: unknown,
      level: "log" | "warn",
    ): Promise<void> => {
      if (!stream || typeof stream !== "object" || !("getReader" in stream)) {
        return;
      }
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).trim();
          if (text.length > 0) {
            this.logger[level](`[message_gateway:${state.config.id}] ${text}`);
          }
        }
      } catch {}
    };

    void pump(process.stdout, "log");
    void pump(process.stderr, "warn");

    void process.exited.then((code) => {
      state.running = false;
      state.error = `process exited with code ${code}`;
      if (!this.stopping) {
        this.logger.warn(`[message_gateway] channel ${state.config.id} exited (${code})`);
      }
    });
  }

  private async startChannel(state: ChannelRuntimeState): Promise<void> {
    const pluginEntry = resolveMessageGatewayPluginEntry(state.config.type);
    const channelConfig = JSON.stringify(state.config);
    const gatewayConfig = JSON.stringify({
      inboundPath: this.config.gateway.inboundPath,
      bearerToken: this.config.gateway.auth.bearerToken,
    });

    try {
      const proc = Bun.spawn([process.execPath, pluginEntry], {
        env: {
          ...process.env,
          ATOM_MESSAGE_GATEWAY_CHANNEL_CONFIG: channelConfig,
          ATOM_MESSAGE_GATEWAY_GLOBAL_CONFIG: gatewayConfig,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      state.process = proc;
      state.pid = proc.pid;
      this.attachProcessLifecycleLogs(state);
      await this.waitForChannelHealth(state);
      this.logger.log(
        `[message_gateway] channel ${state.config.id} ready at ${state.endpointBaseUrl}${state.config.channelEndpoint.invokePath}`,
      );
    } catch (error) {
      state.running = false;
      state.error = toErrorMessage(error);
      this.logger.warn(
        `[message_gateway] channel ${state.config.id} failed to start: ${state.error}`,
      );
      state.process?.kill();
    }
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.log("[message_gateway] disabled");
      return;
    }

    const channels = this.getSelectedChannels();
    for (const channel of channels) {
      const state = this.registerChannelState(channel);
      await this.startChannel(state);
    }

    this.logger.log(
      `[message_gateway] started ${channels.length} configured channel(s), running=${[...this.states.values()].filter((state) => state.running).length}`,
    );
  }

  private async callChannelRpc<T>(
    state: ChannelRuntimeState,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!state.running) {
      throw new Error(`Channel ${state.config.id} is not running`);
    }

    const url = `${state.endpointBaseUrl}${state.config.channelEndpoint.invokePath}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
    });

    const result = await ensureOk(response, `channel ${state.config.id} rpc ${method}`);
    return result as T;
  }

  private async awaitTaskResult(taskId: string): Promise<string> {
    while (true) {
      const taskStatus = await this.runtime.getTask(taskId);
      if (!taskStatus) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (isTaskRunning(taskStatus.task.status)) {
        await sleep(800);
        continue;
      }

      const summary = summarizeCompletedTask(taskStatus.task);
      if (summary.kind === "assistant_reply") {
        return summary.replyText;
      }
      return summary.statusNotice;
    }
  }

  private async deliverText(
    state: ChannelRuntimeState,
    request: MessageGatewayDeliverRequest,
  ): Promise<MessageGatewayDeliverResult> {
    return await this.callChannelRpc<MessageGatewayDeliverResult>(state, "channel.deliver", {
      request,
    });
  }

  private buildTaskInput(
    channelId: string,
    conversationId: string,
    senderId: string | undefined,
    text: string,
  ): string {
    const sender = senderId?.trim() || "unknown";
    return `[channel=${channelId} conversation=${conversationId} sender=${sender}]\n${text}`;
  }

  private async processInboundAsync(
    state: ChannelRuntimeState,
    payload: MessageGatewayParseInboundResult,
  ): Promise<void> {
    const immediateResponses = payload.immediateResponses ?? [];
    for (const response of immediateResponses) {
      try {
        await this.deliverText(state, {
          conversationId: response.conversationId,
          text: response.text,
          context: response.metadata,
        });
      } catch (error) {
        this.logger.warn(
          `[message_gateway] immediate response failed (${state.config.id}): ${toErrorMessage(error)}`,
        );
      }
    }

    for (const message of payload.messages) {
      try {
        const taskInput = this.buildTaskInput(
          state.config.id,
          message.conversationId,
          message.senderId,
          message.text,
        );
        const created = await this.runtime.submitTask({
          type: "message_gateway.input",
          input: taskInput,
        });
        const replyText = await this.awaitTaskResult(created.taskId);
        await this.deliverText(state, {
          conversationId: message.conversationId,
          text: replyText,
          context: {
            sourceMessageId: message.messageId,
            ...(message.metadata ?? {}),
          },
        });
      } catch (error) {
        this.logger.warn(
          `[message_gateway] failed to process inbound message (${state.config.id}): ${toErrorMessage(error)}`,
        );
      }
    }
  }

  async handleInbound(request: Request, url: URL): Promise<Response> {
    if (!this.enabled) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Message gateway is disabled",
          },
        }),
        {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    const expectedToken = this.config.gateway.auth.bearerToken;
    const bearer = parseBearerToken(request.headers.get("authorization"));
    const queryToken = url.searchParams.get("token")?.trim();
    if (expectedToken !== bearer && expectedToken !== queryToken) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "BAD_REQUEST",
            message: "Unauthorized message gateway request",
          },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    const channelId =
      request.headers.get("x-message-gateway-channel-id")?.trim() ||
      url.searchParams.get("channelId")?.trim();
    if (!channelId) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "BAD_REQUEST",
            message: "Missing channelId",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    const state = this.states.get(channelId);
    if (!state) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Channel not found: ${channelId}`,
          },
        }),
        {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    if (!state.running) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: `Channel unavailable: ${channelId}`,
          },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    const rawBody = await request.text();
    let body: unknown = undefined;
    if (rawBody.trim() !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
    }

    const inboundRequest: MessageGatewayInboundRequest = {
      requestId: randomUUID(),
      method: request.method,
      headers: normalizeHeaderMap(request.headers),
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      rawBody,
      receivedAt: Date.now(),
    };

    let parsed: MessageGatewayParseInboundResult;
    try {
      parsed = await this.callChannelRpc<MessageGatewayParseInboundResult>(
        state,
        "channel.parseInbound",
        { request: inboundRequest },
      );
    } catch (error) {
      this.logger.warn(
        `[message_gateway] inbound parse failed (${channelId}): ${toErrorMessage(error)}`,
      );
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: `Inbound parse failed for channel ${channelId}`,
          },
        }),
        {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    if (parsed.accepted && (parsed.messages.length > 0 || (parsed.immediateResponses?.length ?? 0) > 0)) {
      void this.processInboundAsync(state, parsed);
    }
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          accepted: parsed.accepted,
          channelId,
          requestId: inboundRequest.requestId,
          queuedMessages: parsed.messages.length,
        },
      }),
      {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;

    for (const state of this.states.values()) {
      if (!state.process) continue;

      try {
        if (state.running) {
          await this.callChannelRpc<{ stopped: boolean }>(state, "channel.shutdown", {});
        }
      } catch {}

      try {
        state.process.kill();
      } catch {}

      try {
        await state.process.exited;
      } catch {}

      state.running = false;
    }
  }
}
