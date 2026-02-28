import type { ResolvedMessageGatewayChannelConfig } from "./types";

export type MessageGatewayGlobalPluginConfig = {
  inboundPath: string;
  bearerToken: string;
};

export const trimToUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

export const resolveSecret = (
  options: {
    envName?: unknown;
    inlineValue?: unknown;
    fieldLabel: string;
    required?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const envName = trimToUndefined(options.envName);
  const envValue = envName ? trimToUndefined(env[envName]) : undefined;
  const inlineValue = trimToUndefined(options.inlineValue);
  const resolved = envValue ?? inlineValue;
  if (!resolved && options.required !== false) {
    throw new Error(`${options.fieldLabel} is required`);
  }
  return resolved;
};

export const assertChannelSettingsObject = (
  channel: ResolvedMessageGatewayChannelConfig,
): Record<string, unknown> => {
  const settings = channel.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`channel settings must be object (${channel.id})`);
  }
  return settings;
};
