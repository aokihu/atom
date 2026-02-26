import type { AgentConfig, AgentProviderConfig } from "../../../types/agent";
import { BUILTIN_TOOL_PERMISSION_SECTIONS } from "./constants";

const ensureStringArray = (value: unknown, keyPath: string) => {
  if (value === undefined) return;

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${keyPath} must be an array of string`);
  }
};

const ensureBoolean = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new Error(`${keyPath} must be a boolean`);
  }
};

const ensureStringRecord = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${keyPath} must be an object of string values`);
  }

  for (const [key, recordValue] of Object.entries(value)) {
    if (typeof recordValue !== "string") {
      throw new Error(`${keyPath}.${key} must be a string`);
    }
  }
};

const ensureNonEmptyString = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`${keyPath} must be a string`);
  }
  if (value.trim() === "") {
    throw new Error(`${keyPath} must be a non-empty string`);
  }
};

const ensureRequiredNonEmptyString = (value: unknown, keyPath: string) => {
  if (value === undefined) {
    throw new Error(`${keyPath} must be a non-empty string`);
  }

  ensureNonEmptyString(value, keyPath);
};

const ensureNumber = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${keyPath} must be a number`);
  }
};

const ensureInteger = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  ensureNumber(value, keyPath);
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new Error(`${keyPath} must be an integer`);
  }
};

const ensurePositiveInteger = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  ensureInteger(value, keyPath);
  if (typeof value === "number" && value <= 0) {
    throw new Error(`${keyPath} must be a positive integer`);
  }
};

const ensureNumberInRange = (
  value: unknown,
  keyPath: string,
  range: { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean },
) => {
  if (value === undefined) return;
  ensureNumber(value, keyPath);
  if (typeof value !== "number") return;

  if (range.min !== undefined) {
    const invalid = range.minExclusive ? value <= range.min : value < range.min;
    if (invalid) {
      const relation = range.minExclusive ? ">" : ">=";
      throw new Error(`${keyPath} must be ${relation} ${range.min}`);
    }
  }

  if (range.max !== undefined) {
    const invalid = range.maxExclusive ? value >= range.max : value > range.max;
    if (invalid) {
      const relation = range.maxExclusive ? "<" : "<=";
      throw new Error(`${keyPath} must be ${relation} ${range.max}`);
    }
  }
};

const validateAgentModelParams = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${keyPath} must be a JSON object`);
  }

  const params = value as Record<string, unknown>;
  ensurePositiveInteger(params.maxOutputTokens, `${keyPath}.maxOutputTokens`);
  ensureNumberInRange(params.temperature, `${keyPath}.temperature`, { min: 0, max: 2 });
  ensureNumberInRange(params.topP, `${keyPath}.topP`, { min: 0, max: 1, minExclusive: true });
  ensurePositiveInteger(params.topK, `${keyPath}.topK`);
  ensureNumber(params.presencePenalty, `${keyPath}.presencePenalty`);
  ensureNumber(params.frequencyPenalty, `${keyPath}.frequencyPenalty`);
  ensureStringArray(params.stopSequences, `${keyPath}.stopSequences`);
  ensureInteger(params.seed, `${keyPath}.seed`);
};

const validateAgentExecutionConfig = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${keyPath} must be a JSON object`);
  }

  const execution = value as Record<string, unknown>;
  ensurePositiveInteger(execution.maxModelStepsPerRun, `${keyPath}.maxModelStepsPerRun`);
  ensureBoolean(execution.autoContinueOnStepLimit, `${keyPath}.autoContinueOnStepLimit`);
  ensurePositiveInteger(execution.maxToolCallsPerTask, `${keyPath}.maxToolCallsPerTask`);
  ensurePositiveInteger(execution.maxContinuationRuns, `${keyPath}.maxContinuationRuns`);
  ensurePositiveInteger(execution.maxModelStepsPerTask, `${keyPath}.maxModelStepsPerTask`);
  ensureBoolean(
    execution.continueWithoutAdvancingContextRound,
    `${keyPath}.continueWithoutAdvancingContextRound`,
  );
};

const parseAgentModelRef = (value: string) => {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    throw new Error("agent.model must be in '<provider_id>/<model>' format");
  }

  return {
    providerId: value.slice(0, separatorIndex),
    model: value.slice(separatorIndex + 1),
  };
};

const validateAgentAndProvidersConfig = (config: AgentConfig) => {
  const rawConfig = config as AgentConfig & Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawConfig, "agentName")) {
    throw new Error("agentName is deprecated; use agent.name");
  }

  const agent = config.agent;
  if (agent === undefined) {
    throw new Error("agent must be a JSON object");
  }
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
    throw new Error("agent must be a JSON object");
  }

  ensureNonEmptyString(agent.name, "agent.name");
  ensureRequiredNonEmptyString(agent.model, "agent.model");
  validateAgentModelParams(agent.params, "agent.params");
  validateAgentExecutionConfig(agent.execution, "agent.execution");
  if (typeof agent.model !== "string") {
    return;
  }

  const agentModelRef = parseAgentModelRef(agent.model);

  const providers = config.providers;
  if (providers === undefined) {
    throw new Error("providers must be a non-empty array");
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("providers must be a non-empty array");
  }

  const seenProviderIds = new Set<string>();
  let selectedProvider: AgentProviderConfig | undefined;

  providers.forEach((provider, index) => {
    const keyPath = `providers[${index}]`;
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      throw new Error(`${keyPath} must be an object`);
    }

    ensureRequiredNonEmptyString(provider.provider_id, `${keyPath}.provider_id`);
    ensureRequiredNonEmptyString(provider.model, `${keyPath}.model`);
    ensureRequiredNonEmptyString(provider.api_key, `${keyPath}.api_key`);
    ensureBoolean(provider.enabled, `${keyPath}.enabled`);
    ensureNonEmptyString(provider.base_url, `${keyPath}.base_url`);
    ensureStringRecord(provider.headers, `${keyPath}.headers`);

    if (typeof provider.base_url === "string") {
      try {
        new URL(provider.base_url);
      } catch {
        throw new Error(`${keyPath}.base_url is invalid URL`);
      }
    }

    if (
      typeof provider.provider_id === "string" &&
      !/^[a-zA-Z0-9_-]+$/.test(provider.provider_id)
    ) {
      throw new Error(`${keyPath}.provider_id must match /^[a-zA-Z0-9_-]+$/`);
    }

    if (typeof provider.provider_id !== "string") {
      return;
    }

    if (seenProviderIds.has(provider.provider_id)) {
      throw new Error(`Duplicate provider_id: ${provider.provider_id}`);
    }
    seenProviderIds.add(provider.provider_id);

    if (provider.provider_id === agentModelRef.providerId) {
      selectedProvider = provider;
    }
  });

  if (!selectedProvider) {
    throw new Error(
      `agent.model references unknown provider_id: ${agentModelRef.providerId}`,
    );
  }

  if (selectedProvider.enabled === false) {
    throw new Error(
      `agent.model references disabled provider_id: ${agentModelRef.providerId}`,
    );
  }

  if (selectedProvider.model !== agentModelRef.model) {
    throw new Error("agent.model model part does not match providers[i].model");
  }
};

export const validateToolsConfig = (config: AgentConfig) => {
  const permissions = config.permissions;
  if (permissions === undefined) return;

  for (const section of BUILTIN_TOOL_PERMISSION_SECTIONS) {
    const rule = permissions[section];
    if (!rule) continue;

    ensureStringArray(rule.allow, `permissions.${section}.allow`);
    ensureStringArray(rule.deny, `permissions.${section}.deny`);

    for (const regexText of [...(rule.allow ?? []), ...(rule.deny ?? [])]) {
      try {
        new RegExp(regexText);
      } catch {
        throw new Error(`Invalid regex in permissions.${section}: ${regexText}`);
      }
    }
  }
};

export const validateMcpConfig = (config: AgentConfig) => {
  const mcp = config.mcp;
  if (mcp === undefined) return;

  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    throw new Error("mcp must be a JSON object");
  }

  const servers = mcp.servers;
  if (servers === undefined) return;

  if (!Array.isArray(servers)) {
    throw new Error("mcp.servers must be an array");
  }

  const seenIds = new Set<string>();

  servers.forEach((server, index) => {
    const keyPath = `mcp.servers[${index}]`;
    if (typeof server !== "object" || server === null || Array.isArray(server)) {
      throw new Error(`${keyPath} must be an object`);
    }

    if (typeof server.id !== "string" || server.id.trim() === "") {
      throw new Error(`${keyPath}.id must be a non-empty string`);
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(server.id)) {
      throw new Error(
        `${keyPath}.id must match /^[a-zA-Z0-9_-]+$/ for MCP tool namespacing`,
      );
    }

    if (seenIds.has(server.id)) {
      throw new Error(`Duplicate MCP server id: ${server.id}`);
    }
    seenIds.add(server.id);

    ensureBoolean(server.enabled, `${keyPath}.enabled`);

    const transport = server.transport;
    if (
      typeof transport !== "object" ||
      transport === null ||
      Array.isArray(transport)
    ) {
      throw new Error(`${keyPath}.transport must be an object`);
    }

    if (transport.type === "http") {
      if (typeof transport.url !== "string" || transport.url.trim() === "") {
        throw new Error(`${keyPath}.transport.url must be a non-empty string`);
      }

      try {
        new URL(transport.url);
      } catch {
        throw new Error(`${keyPath}.transport.url is invalid URL`);
      }

      ensureStringRecord(transport.headers, `${keyPath}.transport.headers`);
      return;
    }

    if (transport.type === "stdio") {
      ensureRequiredNonEmptyString(transport.command, `${keyPath}.transport.command`);
      ensureStringArray(transport.args, `${keyPath}.transport.args`);
      ensureStringRecord(transport.env, `${keyPath}.transport.env`);
      ensureNonEmptyString(transport.cwd, `${keyPath}.transport.cwd`);
      return;
    }

    throw new Error(`${keyPath}.transport.type must be "http" or "stdio"`);
  });
};

export const validateTuiConfig = (config: AgentConfig) => {
  const tui = config.tui;
  if (tui === undefined) return;

  if (typeof tui !== "object" || tui === null || Array.isArray(tui)) {
    throw new Error("tui must be a JSON object");
  }

  ensureNonEmptyString(tui.theme, "tui.theme");
};

export const validateAgentConfig = (config: AgentConfig) => {
  validateAgentAndProvidersConfig(config);
  validateToolsConfig(config);
  validateMcpConfig(config);
  validateTuiConfig(config);
};
