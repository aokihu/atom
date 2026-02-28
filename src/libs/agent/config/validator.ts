import {
  AGENT_INTENT_GUARD_INTENT_KINDS,
  AGENT_INTENT_GUARD_TOOL_FAMILIES,
  type AgentConfig,
  type AgentProviderConfig,
} from "../../../types/agent";
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

const ensureEnvVarName = (value: unknown, keyPath: string) => {
  if (value === undefined) return;
  ensureNonEmptyString(value, keyPath);
  if (typeof value !== "string") return;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error(
      `${keyPath} must match /^[A-Z_][A-Z0-9_]*$/`,
    );
  }
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

const ensureIntegerInRange = (
  value: unknown,
  keyPath: string,
  range: { min: number; max: number },
) => {
  if (value === undefined) return;
  ensureInteger(value, keyPath);
  if (typeof value !== "number") return;
  if (value < range.min || value > range.max) {
    throw new Error(`${keyPath} must be an integer in range ${range.min}..${range.max}`);
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

const ensureEnumValue = (
  value: unknown,
  keyPath: string,
  allowed: readonly string[],
) => {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${keyPath} must be one of: ${allowed.join(", ")}`);
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

  const intentGuard = execution.intentGuard;
  if (intentGuard !== undefined) {
    if (typeof intentGuard !== "object" || intentGuard === null || Array.isArray(intentGuard)) {
      throw new Error(`${keyPath}.intentGuard must be a JSON object`);
    }

    const intentGuardConfig = intentGuard as Record<string, unknown>;
    ensureBoolean(intentGuardConfig.enabled, `${keyPath}.intentGuard.enabled`);
    ensureEnumValue(intentGuardConfig.detector, `${keyPath}.intentGuard.detector`, ["model", "heuristic"]);
    ensureIntegerInRange(intentGuardConfig.softBlockAfter, `${keyPath}.intentGuard.softBlockAfter`, {
      min: 0,
      max: 12,
    });

    const browser = intentGuardConfig.browser;
    if (browser !== undefined) {
      if (typeof browser !== "object" || browser === null || Array.isArray(browser)) {
        throw new Error(`${keyPath}.intentGuard.browser must be a JSON object`);
      }

      const browserPolicy = browser as Record<string, unknown>;
      ensureBoolean(browserPolicy.noFallback, `${keyPath}.intentGuard.browser.noFallback`);
      ensureBoolean(
        browserPolicy.networkAdjacentOnly,
        `${keyPath}.intentGuard.browser.networkAdjacentOnly`,
      );
      ensureBoolean(
        browserPolicy.failTaskIfUnmet,
        `${keyPath}.intentGuard.browser.failTaskIfUnmet`,
      );
    }

    const intents = intentGuardConfig.intents;
    if (intents !== undefined) {
      if (typeof intents !== "object" || intents === null || Array.isArray(intents)) {
        throw new Error(`${keyPath}.intentGuard.intents must be a JSON object`);
      }

      for (const [intentKey, intentPolicy] of Object.entries(intents)) {
        if (!AGENT_INTENT_GUARD_INTENT_KINDS.includes(intentKey as any)) {
          throw new Error(
            `${keyPath}.intentGuard.intents.${intentKey} is unsupported; allowed: ${AGENT_INTENT_GUARD_INTENT_KINDS.join(", ")}`,
          );
        }

        if (
          intentPolicy === undefined ||
          intentPolicy === null ||
          typeof intentPolicy !== "object" ||
          Array.isArray(intentPolicy)
        ) {
          throw new Error(`${keyPath}.intentGuard.intents.${intentKey} must be a JSON object`);
        }

        const policy = intentPolicy as Record<string, unknown>;
        ensureBoolean(policy.enabled, `${keyPath}.intentGuard.intents.${intentKey}.enabled`);
        ensureIntegerInRange(
          policy.softBlockAfter,
          `${keyPath}.intentGuard.intents.${intentKey}.softBlockAfter`,
          { min: 0, max: 12 },
        );
        ensureBoolean(policy.noFallback, `${keyPath}.intentGuard.intents.${intentKey}.noFallback`);
        ensureBoolean(
          policy.failTaskIfUnmet,
          `${keyPath}.intentGuard.intents.${intentKey}.failTaskIfUnmet`,
        );
        ensureStringArray(
          policy.allowedFamilies,
          `${keyPath}.intentGuard.intents.${intentKey}.allowedFamilies`,
        );
        ensureStringArray(
          policy.softAllowedFamilies,
          `${keyPath}.intentGuard.intents.${intentKey}.softAllowedFamilies`,
        );
        ensureStringArray(
          policy.requiredSuccessFamilies,
          `${keyPath}.intentGuard.intents.${intentKey}.requiredSuccessFamilies`,
        );

        for (const family of [
          ...(Array.isArray(policy.allowedFamilies) ? policy.allowedFamilies : []),
          ...(Array.isArray(policy.softAllowedFamilies) ? policy.softAllowedFamilies : []),
          ...(Array.isArray(policy.requiredSuccessFamilies) ? policy.requiredSuccessFamilies : []),
        ]) {
          if (!AGENT_INTENT_GUARD_TOOL_FAMILIES.includes(family as any)) {
            throw new Error(
              `${keyPath}.intentGuard.intents.${intentKey} has unsupported family "${family}"; allowed: ${AGENT_INTENT_GUARD_TOOL_FAMILIES.join(", ")}`,
            );
          }
        }
      }
    }
  }
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
    ensureNonEmptyString(provider.api_key, `${keyPath}.api_key`);
    ensureEnvVarName(provider.api_key_env, `${keyPath}.api_key_env`);
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

export const validateMemoryConfig = (config: AgentConfig) => {
  const memory = (config as AgentConfig & Record<string, unknown>).memory;
  if (memory === undefined) return;

  if (typeof memory !== "object" || memory === null || Array.isArray(memory)) {
    throw new Error("memory must be a JSON object");
  }

  const persistent = (memory as Record<string, unknown>).persistent;
  if (persistent === undefined) return;

  if (typeof persistent !== "object" || persistent === null || Array.isArray(persistent)) {
    throw new Error("memory.persistent must be a JSON object");
  }

  const persistentConfig = persistent as Record<string, unknown>;
  ensureBoolean(persistentConfig.enabled, "memory.persistent.enabled");
  ensureBoolean(persistentConfig.autoRecall, "memory.persistent.autoRecall");
  ensureBoolean(persistentConfig.autoCapture, "memory.persistent.autoCapture");
  ensurePositiveInteger(persistentConfig.maxRecallItems, "memory.persistent.maxRecallItems");
  if (
    typeof persistentConfig.maxRecallItems === "number" &&
    persistentConfig.maxRecallItems > 12
  ) {
    throw new Error("memory.persistent.maxRecallItems must be <= 12");
  }
  ensurePositiveInteger(
    persistentConfig.maxRecallLongtermItems,
    "memory.persistent.maxRecallLongtermItems",
  );
  if (
    typeof persistentConfig.maxRecallLongtermItems === "number" &&
    persistentConfig.maxRecallLongtermItems > 24
  ) {
    throw new Error("memory.persistent.maxRecallLongtermItems must be <= 24");
  }

  ensureNumberInRange(
    persistentConfig.minCaptureConfidence,
    "memory.persistent.minCaptureConfidence",
    { min: 0, max: 1 },
  );
  ensureEnumValue(
    persistentConfig.searchMode,
    "memory.persistent.searchMode",
    ["auto", "fts", "like"],
  );

  const tagging = persistentConfig.tagging;
  if (tagging !== undefined) {
    if (typeof tagging !== "object" || tagging === null || Array.isArray(tagging)) {
      throw new Error("memory.persistent.tagging must be a JSON object");
    }

    const taggingConfig = tagging as Record<string, unknown>;
    ensureNumberInRange(
      taggingConfig.reuseProbabilityThreshold,
      "memory.persistent.tagging.reuseProbabilityThreshold",
      { min: 0, max: 1 },
    );
    ensureIntegerInRange(
      taggingConfig.placeholderSummaryMaxLen,
      "memory.persistent.tagging.placeholderSummaryMaxLen",
      { min: 24, max: 240 },
    );

    const reactivatePolicy = taggingConfig.reactivatePolicy;
    if (reactivatePolicy !== undefined) {
      if (
        typeof reactivatePolicy !== "object" ||
        reactivatePolicy === null ||
        Array.isArray(reactivatePolicy)
      ) {
        throw new Error("memory.persistent.tagging.reactivatePolicy must be a JSON object");
      }

      const reactivatePolicyConfig = reactivatePolicy as Record<string, unknown>;
      ensureBoolean(
        reactivatePolicyConfig.enabled,
        "memory.persistent.tagging.reactivatePolicy.enabled",
      );
      ensureIntegerInRange(
        reactivatePolicyConfig.hitCountThreshold,
        "memory.persistent.tagging.reactivatePolicy.hitCountThreshold",
        { min: 1, max: 12 },
      );
      ensureIntegerInRange(
        reactivatePolicyConfig.windowHours,
        "memory.persistent.tagging.reactivatePolicy.windowHours",
        { min: 1, max: 168 },
      );
    }

    const scheduler = taggingConfig.scheduler;
    if (scheduler !== undefined) {
      if (typeof scheduler !== "object" || scheduler === null || Array.isArray(scheduler)) {
        throw new Error("memory.persistent.tagging.scheduler must be a JSON object");
      }

      const schedulerConfig = scheduler as Record<string, unknown>;
      ensureBoolean(schedulerConfig.enabled, "memory.persistent.tagging.scheduler.enabled");
      ensureBoolean(schedulerConfig.adaptive, "memory.persistent.tagging.scheduler.adaptive");
      ensureIntegerInRange(
        schedulerConfig.baseIntervalMinutes,
        "memory.persistent.tagging.scheduler.baseIntervalMinutes",
        { min: 1, max: 720 },
      );
      ensureIntegerInRange(
        schedulerConfig.minIntervalMinutes,
        "memory.persistent.tagging.scheduler.minIntervalMinutes",
        { min: 1, max: 720 },
      );
      ensureIntegerInRange(
        schedulerConfig.maxIntervalMinutes,
        "memory.persistent.tagging.scheduler.maxIntervalMinutes",
        { min: 1, max: 720 },
      );
      ensureNumberInRange(
        schedulerConfig.jitterRatio,
        "memory.persistent.tagging.scheduler.jitterRatio",
        { min: 0, max: 0.5 },
      );
    }
  }
};

export const validateTuiConfig = (config: AgentConfig) => {
  const tui = config.tui;
  if (tui === undefined) return;

  if (typeof tui !== "object" || tui === null || Array.isArray(tui)) {
    throw new Error("tui must be a JSON object");
  }

  ensureNonEmptyString(tui.theme, "tui.theme");
};

export const validateTelegramConfig = (config: AgentConfig) => {
  const telegram = config.telegram;
  if (telegram === undefined) return;
  throw new Error(
    "telegram config has been removed from agent.config.json. Move channel settings to message_gateway.config.json",
  );
};

export const validateAgentConfig = (config: AgentConfig) => {
  validateAgentAndProvidersConfig(config);
  validateToolsConfig(config);
  validateMemoryConfig(config);
  validateMcpConfig(config);
  validateTuiConfig(config);
  validateTelegramConfig(config);
};
