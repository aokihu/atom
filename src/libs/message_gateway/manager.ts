import { sleep } from "bun";

import type {
  MessageGatewayHealthStatus,
  ResolvedMessageGatewayChannelConfig,
  ResolvedMessageGatewayConfig,
} from "../../types/message_gateway";
import { loadMessageGatewayConfig } from "./config";
import { resolveMessageGatewayPluginEntry } from "./registry";

type Logger = Pick<Console, "log" | "warn">;

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
  includeChannels?: string[];
  configPath?: string;
  logger?: Logger;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MessageGatewayManager {
  readonly inboundPath: string;
  private readonly logger: Logger;
  private readonly includeChannels: Set<string> | null;
  private readonly states = new Map<string, ChannelRuntimeState>();
  private stopping = false;
  private serverUrl?: string;

  constructor(
    private readonly config: ResolvedMessageGatewayConfig,
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
    return new MessageGatewayManager(config, {
      includeChannels: options.includeChannels,
      logger: options.logger,
    });
  }

  setServerUrl(serverUrl: string): void {
    this.serverUrl = serverUrl;
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
      enabled: this.config.gateway.enabled,
      inboundPath: this.config.gateway.inboundPath,
      auth: this.config.gateway.auth,
    });

    try {
      const proc = Bun.spawn([process.execPath, pluginEntry], {
        env: {
          ...process.env,
          ATOM_MESSAGE_GATEWAY_CHANNEL_CONFIG: channelConfig,
          ATOM_MESSAGE_GATEWAY_GLOBAL_CONFIG: gatewayConfig,
          ...(this.serverUrl
            ? { ATOM_MESSAGE_GATEWAY_SERVER_URL: this.serverUrl }
            : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      state.process = proc;
      state.pid = proc.pid;
      this.attachProcessLifecycleLogs(state);
      await this.waitForChannelHealth(state);
      this.logger.log(
        `[message_gateway] channel ${state.config.id} ready at ${state.endpointBaseUrl}${state.config.channelEndpoint.healthPath}`,
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

    if (!this.serverUrl) {
      throw new Error("message gateway serverUrl is required before start");
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

  async stop(): Promise<void> {
    this.stopping = true;

    for (const state of this.states.values()) {
      if (!state.process) continue;

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
