import { resolve } from "node:path";

import type {
  MessageGatewayConfig,
  MessageGatewayChannelConfig,
  ResolvedMessageGatewayConfig,
  ResolvedMessageGatewayChannelConfig,
} from "../../types/message_gateway";
import {
  DEFAULT_MESSAGE_GATEWAY_ENDPOINT_HOST,
  DEFAULT_MESSAGE_GATEWAY_HEALTH_PATH,
  DEFAULT_MESSAGE_GATEWAY_INBOUND_PATH,
  DEFAULT_MESSAGE_GATEWAY_INVOKE_PATH,
  DEFAULT_MESSAGE_GATEWAY_STARTUP_TIMEOUT_MS,
  MESSAGE_GATEWAY_CONFIG_FILENAME,
} from "./constants";

export type LoadMessageGatewayConfigOptions = {
  workspace: string;
  configPath?: string;
};

const trimToUndefined = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const ensureObject = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

const ensureNonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
};

const ensureIntegerInRange = (
  value: unknown,
  path: string,
  min: number,
  max: number,
): number => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path} must be an integer in range ${min}..${max}`);
  }
  return value as number;
};

const normalizeInboundPath = (path: string): string => {
  const normalized = path.trim();
  if (!normalized.startsWith("/")) {
    throw new Error("message_gateway.gateway.inboundPath must start with /");
  }
  return normalized;
};

const resolveBearerToken = (
  auth: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): string => {
  const tokenEnvName = trimToUndefined(
    typeof auth?.bearerTokenEnv === "string" ? auth.bearerTokenEnv : undefined,
  );
  const tokenFromEnv = tokenEnvName ? trimToUndefined(env[tokenEnvName]) : undefined;
  const tokenFromConfig = trimToUndefined(
    typeof auth?.bearerToken === "string" ? auth.bearerToken : undefined,
  );
  const resolved = tokenFromEnv ?? tokenFromConfig;
  if (!resolved) {
    throw new Error(
      "Message gateway token is required. Set message_gateway.gateway.auth.bearerToken or bearerTokenEnv",
    );
  }
  return resolved;
};

const resolveChannel = (
  channel: MessageGatewayChannelConfig,
  index: number,
): ResolvedMessageGatewayChannelConfig => {
  const prefix = `message_gateway.channels[${index}]`;
  const id = ensureNonEmptyString(channel.id, `${prefix}.id`);
  if (channel.type !== "telegram" && channel.type !== "http") {
    throw new Error(`${prefix}.type must be one of: telegram, http`);
  }

  const endpoint = ensureObject(channel.channelEndpoint, `${prefix}.channelEndpoint`);
  const host =
    trimToUndefined(
      typeof endpoint.host === "string" ? endpoint.host : undefined,
    ) ?? DEFAULT_MESSAGE_GATEWAY_ENDPOINT_HOST;
  const port = ensureIntegerInRange(endpoint.port, `${prefix}.channelEndpoint.port`, 1, 65535);
  const healthPath =
    trimToUndefined(
      typeof endpoint.healthPath === "string" ? endpoint.healthPath : undefined,
    ) ?? DEFAULT_MESSAGE_GATEWAY_HEALTH_PATH;
  const invokePath =
    trimToUndefined(
      typeof endpoint.invokePath === "string" ? endpoint.invokePath : undefined,
    ) ?? DEFAULT_MESSAGE_GATEWAY_INVOKE_PATH;
  const startupTimeoutMs =
    endpoint.startupTimeoutMs === undefined
      ? DEFAULT_MESSAGE_GATEWAY_STARTUP_TIMEOUT_MS
      : ensureIntegerInRange(
          endpoint.startupTimeoutMs,
          `${prefix}.channelEndpoint.startupTimeoutMs`,
          1000,
          120000,
        );

  if (!healthPath.startsWith("/")) {
    throw new Error(`${prefix}.channelEndpoint.healthPath must start with /`);
  }
  if (!invokePath.startsWith("/")) {
    throw new Error(`${prefix}.channelEndpoint.invokePath must start with /`);
  }

  const settingsRaw = channel.settings;
  if (
    settingsRaw !== undefined &&
    (typeof settingsRaw !== "object" || settingsRaw === null || Array.isArray(settingsRaw))
  ) {
    throw new Error(`${prefix}.settings must be a JSON object`);
  }

  return {
    id,
    type: channel.type,
    enabled: channel.enabled !== false,
    channelEndpoint: {
      host,
      port,
      healthPath,
      invokePath,
      startupTimeoutMs,
    },
    settings: (settingsRaw as Record<string, unknown> | undefined) ?? {},
  };
};

export const validateMessageGatewayConfig = (config: MessageGatewayConfig): void => {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("message_gateway.config must be a JSON object");
  }

  if (config.gateway !== undefined) {
    ensureObject(config.gateway, "message_gateway.gateway");
  }

  if (config.channels !== undefined) {
    if (!Array.isArray(config.channels)) {
      throw new Error("message_gateway.channels must be an array");
    }
    for (let i = 0; i < config.channels.length; i += 1) {
      ensureObject(config.channels[i], `message_gateway.channels[${i}]`);
    }
  }
};

export const resolveMessageGatewayConfig = (
  config: MessageGatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMessageGatewayConfig => {
  validateMessageGatewayConfig(config);

  const gatewayObject = config.gateway
    ? ensureObject(config.gateway, "message_gateway.gateway")
    : {};
  const enabled = gatewayObject.enabled !== false;
  const inboundPath = normalizeInboundPath(
    trimToUndefined(
      typeof gatewayObject.inboundPath === "string" ? gatewayObject.inboundPath : undefined,
    ) ?? DEFAULT_MESSAGE_GATEWAY_INBOUND_PATH,
  );
  const authObject =
    gatewayObject.auth === undefined
      ? undefined
      : ensureObject(gatewayObject.auth, "message_gateway.gateway.auth");
  const bearerToken = enabled ? resolveBearerToken(authObject, env) : "__disabled__";

  const channelsRaw = config.channels ?? [];
  if (!Array.isArray(channelsRaw)) {
    throw new Error("message_gateway.channels must be an array");
  }

  const channels = channelsRaw.map((channel, index) =>
    resolveChannel(channel as MessageGatewayChannelConfig, index),
  );

  const seenIds = new Set<string>();
  for (const channel of channels) {
    if (seenIds.has(channel.id)) {
      throw new Error(`message_gateway.channels contains duplicated id: ${channel.id}`);
    }
    seenIds.add(channel.id);
  }

  return {
    gateway: {
      enabled,
      inboundPath,
      auth: {
        bearerToken,
      },
    },
    channels,
  };
};

export const loadMessageGatewayConfig = async (
  options: LoadMessageGatewayConfigOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedMessageGatewayConfig> => {
  const workspacePath = resolve(options.workspace);
  const filepath = options.configPath
    ? resolve(options.configPath)
    : resolve(workspacePath, MESSAGE_GATEWAY_CONFIG_FILENAME);
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    return resolveMessageGatewayConfig(
      {
        gateway: {
          enabled: false,
          inboundPath: DEFAULT_MESSAGE_GATEWAY_INBOUND_PATH,
        },
        channels: [],
      },
      env,
    );
  }

  const content = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${filepath}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${filepath} must be a JSON object`);
  }

  try {
    return resolveMessageGatewayConfig(raw as MessageGatewayConfig, env);
  } catch (error) {
    throw new Error(
      `Invalid message gateway config (${filepath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
