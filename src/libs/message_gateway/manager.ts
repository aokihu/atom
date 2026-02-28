import { sleep } from "bun";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  logFilePath?: string;
  logStream?: WriteStream;
  running: boolean;
  error?: string;
  pid?: number;
};

export type CreateMessageGatewayManagerOptions = {
  workspace: string;
  messageGatewaySelector?: string;
  configPath?: string;
  logger?: Logger;
};

type ChannelSelection = {
  mode: "none" | "all" | "custom";
  includes: Set<string>;
  excludes: Set<string>;
};

const parseChannelSelection = (selector?: string): ChannelSelection => {
  if (!selector) {
    return {
      mode: "none",
      includes: new Set(),
      excludes: new Set(),
    };
  }

  const normalized = selector.trim();
  if (normalized === "all") {
    return {
      mode: "all",
      includes: new Set(),
      excludes: new Set(),
    };
  }

  const tokens = normalized
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new Error("Invalid --message-gateway. It must include at least one channel id");
  }

  if (tokens.includes("all")) {
    throw new Error(
      "Invalid --message-gateway. Use either `all` or a comma-separated channel selector",
    );
  }

  const includes = new Set<string>();
  const excludes = new Set<string>();

  for (const token of tokens) {
    if (token.startsWith("!")) {
      const channelId = token.slice(1).trim();
      if (channelId.length === 0) {
        throw new Error("Invalid --message-gateway. `!` must be followed by channel id");
      }
      excludes.add(channelId);
      continue;
    }

    includes.add(token);
  }

  return {
    mode: "custom",
    includes,
    excludes,
  };
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sanitizeLogPathSegment = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";

const parseDotEnvContent = (content: string): Record<string, string> => {
  const envVars: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = withoutExport.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hashIndex = value.indexOf(" #");
      if (hashIndex >= 0) {
        value = value.slice(0, hashIndex).trim();
      }
    }
    envVars[key] = value;
  }
  return envVars;
};

export class MessageGatewayManager {
  readonly inboundPath: string;
  private readonly logger: Logger;
  private readonly workspace: string;
  private readonly channelSelection: ChannelSelection;
  private readonly states = new Map<string, ChannelRuntimeState>();
  private stopping = false;
  private serverUrl?: string;
  private workspaceEnvPromise?: Promise<Record<string, string>>;

  constructor(
    private readonly config: ResolvedMessageGatewayConfig,
    options?: {
      workspace: string;
      messageGatewaySelector?: string;
      logger?: Logger;
    },
  ) {
    this.logger = options?.logger ?? console;
    this.workspace = options?.workspace ?? process.cwd();
    this.channelSelection = parseChannelSelection(options?.messageGatewaySelector);
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
      workspace: options.workspace,
      messageGatewaySelector: options.messageGatewaySelector,
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

  private getSelectedChannels(): ResolvedMessageGatewayChannelConfig[] {
    if (this.channelSelection.mode === "none") {
      return [];
    }

    if (this.channelSelection.mode === "all") {
      return this.config.channels.filter((channel) => channel.enabled);
    }

    const channelsById = new Map(this.config.channels.map((channel) => [channel.id, channel]));
    const warnIfUnknown = (channelId: string) => {
      if (!channelsById.has(channelId)) {
        this.logger.warn(
          `[message_gateway] --message-gateway ignored unknown id: ${channelId}`,
        );
      }
    };

    for (const channelId of this.channelSelection.includes) {
      warnIfUnknown(channelId);
    }
    for (const channelId of this.channelSelection.excludes) {
      warnIfUnknown(channelId);
    }

    const baseIds =
      this.channelSelection.includes.size > 0
        ? [...this.channelSelection.includes]
        : this.config.channels
            .filter((channel) => channel.enabled)
            .map((channel) => channel.id);

    const selectedIds = [...new Set(baseIds)].filter(
      (channelId) => !this.channelSelection.excludes.has(channelId),
    );

    return selectedIds
      .map((channelId) => channelsById.get(channelId))
      .filter((channel): channel is ResolvedMessageGatewayChannelConfig => Boolean(channel));
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

  private async openChannelLogStream(state: ChannelRuntimeState): Promise<void> {
    const pluginName = sanitizeLogPathSegment(state.config.id);
    const logsDir = join(
      this.workspace,
      ".agent",
      "message-gateway",
      pluginName,
    );
    await mkdir(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFilePath = join(logsDir, `${timestamp}.log`);
    const stream = createWriteStream(logFilePath, {
      flags: "a",
      encoding: "utf8",
    });
    stream.on("error", (error) => {
      this.logger.warn(
        `[message_gateway] channel ${state.config.id} log stream failed: ${toErrorMessage(error)}`,
      );
    });
    state.logStream = stream;
    state.logFilePath = logFilePath;
    this.writeChannelLogLine(
      state,
      "system",
      `channel=${state.config.id} type=${state.config.type} endpoint=${state.endpointBaseUrl}`,
    );
  }

  private writeChannelLogLine(
    state: ChannelRuntimeState,
    level: "system" | "stdout" | "stderr",
    line: string,
  ): void {
    const stream = state.logStream;
    if (!stream) return;
    stream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
  }

  private closeChannelLogStream(state: ChannelRuntimeState): void {
    if (!state.logStream) return;
    try {
      state.logStream.end();
    } catch {}
    state.logStream = undefined;
  }

  private loadWorkspaceEnv = async (): Promise<Record<string, string>> => {
    if (this.workspaceEnvPromise) {
      return this.workspaceEnvPromise;
    }

    this.workspaceEnvPromise = (async () => {
      const envFilePath = join(this.workspace, ".env");
      const envFile = Bun.file(envFilePath);
      if (!(await envFile.exists())) {
        return {};
      }
      const content = await envFile.text();
      return parseDotEnvContent(content);
    })();

    return this.workspaceEnvPromise;
  };

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
      level: "stdout" | "stderr",
    ): Promise<void> => {
      if (!stream || typeof stream !== "object" || !("getReader" in stream)) {
        return;
      }
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let splitAt = pending.indexOf("\n");
          while (splitAt >= 0) {
            const line = pending.slice(0, splitAt).replace(/\r$/, "");
            this.writeChannelLogLine(state, level, line);
            pending = pending.slice(splitAt + 1);
            splitAt = pending.indexOf("\n");
          }
        }
        pending += decoder.decode();
        const tail = pending.trim();
        if (tail.length > 0) {
          this.writeChannelLogLine(state, level, tail);
        }
      } catch {}
    };

    void pump(process.stdout, "stdout");
    void pump(process.stderr, "stderr");

    void process.exited.then((code) => {
      state.running = false;
      state.error = `process exited with code ${code}`;
      this.writeChannelLogLine(state, "system", state.error);
      this.closeChannelLogStream(state);
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
      await this.openChannelLogStream(state);
      const workspaceEnv = await this.loadWorkspaceEnv();
      const proc = Bun.spawn([process.execPath, pluginEntry], {
        env: {
          ...workspaceEnv,
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
      if (state.logFilePath) {
        this.writeChannelLogLine(state, "system", `health ready log_file=${state.logFilePath}`);
      }
      this.logger.log(
        `[message_gateway] channel ${state.config.id} ready at ${state.endpointBaseUrl}${state.config.channelEndpoint.healthPath}`,
      );
    } catch (error) {
      state.running = false;
      state.error = toErrorMessage(error);
      this.writeChannelLogLine(state, "system", `start failed: ${state.error}`);
      this.logger.warn(
        `[message_gateway] channel ${state.config.id} failed to start: ${state.error}`,
      );
      state.process?.kill();
      this.closeChannelLogStream(state);
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
      this.closeChannelLogStream(state);
    }
  }
}
