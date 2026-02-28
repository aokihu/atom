import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
    DEFAULT_AGENT_EXECUTION_CONFIG,
    type AgentConfig,
    type AgentExecutionConfig,
    type AgentModelParams,
    type AgentProviderConfig,
} from "../../../types/agent";

export type ParsedAgentModelRef = {
    providerId: string;
    modelId: string;
};

export type ResolvedProviderSelection = {
    providerId: string;
    modelId: string;
    provider: AgentProviderConfig;
};

export type ProviderTokenLimits = {
    maxContextTokens?: number;
    maxOutputTokens?: number;
};

export type ProviderBudgetAdjustedRuntimeConfig = {
    modelParams?: AgentModelParams;
    executionConfig?: AgentExecutionConfig;
    tokenLimits: ProviderTokenLimits;
};

type ResolvedRuntimeProviderSelection = ResolvedProviderSelection & {
    apiKey: string;
};

type ProviderModelBuilder = (
    selection: ResolvedRuntimeProviderSelection,
) => LanguageModelV3;

const OPENAI_COMPATIBLE_DEFAULT_BASE_URLS: Record<string, string> = {
    volcengine_coding: "https://ark.cn-beijing.volces.com/api/coding/v3",
    openai: "https://api.openai.com/v1",
    siliconflow: "https://api.siliconflow.cn/v1",
    moonshot: "https://api.moonshot.cn/v1",
    dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    groq: "https://api.groq.com/openai/v1",
    together: "https://api.together.xyz/v1",
    xai: "https://api.x.ai/v1",
    ollama: "http://127.0.0.1:11434/v1",
};

const OPENAI_COMPATIBLE_PROVIDER_IDS = new Set<string>([
    "openai-compatible",
    "volcengine",
    "openai",
    "siliconflow",
    "moonshot",
    "dashscope",
    "groq",
    "together",
    "xai",
    "ollama",
]);

const trimToUndefined = (value: string | undefined) => {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : undefined;
};

const toPositiveIntegerOrUndefined = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
};

const areNumericArraysEqual = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const normalizeDownshiftsWithinLimit = (values: number[], limit: number): number[] => {
    const normalized = values
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .map((value) => Math.trunc(value))
        .filter((value) => value > 0 && value <= limit);

    const uniqueSorted = [...new Set(normalized)].sort((a, b) => b - a);
    if (uniqueSorted.length > 0) {
        return uniqueSorted;
    }

    if (limit <= 1) {
        return [1];
    }
    return [Math.max(1, Math.floor(limit / 2))];
};

export const resolveProviderTokenLimits = (
    provider: Pick<AgentProviderConfig, "max_context_tokens" | "max_output_tokens">,
): ProviderTokenLimits => ({
    maxContextTokens: toPositiveIntegerOrUndefined(provider.max_context_tokens),
    maxOutputTokens: toPositiveIntegerOrUndefined(provider.max_output_tokens),
});

export const applyProviderTokenLimitsToRuntimeConfig = (args: {
    provider: AgentProviderConfig;
    modelParams?: AgentModelParams;
    executionConfig?: AgentExecutionConfig;
}): ProviderBudgetAdjustedRuntimeConfig => {
    const tokenLimits = resolveProviderTokenLimits(args.provider);
    let modelParams = args.modelParams;
    let executionConfig = args.executionConfig;

    if (
        tokenLimits.maxOutputTokens !== undefined &&
        typeof args.modelParams?.maxOutputTokens === "number" &&
        args.modelParams.maxOutputTokens > tokenLimits.maxOutputTokens
    ) {
        modelParams = {
            ...args.modelParams,
            maxOutputTokens: tokenLimits.maxOutputTokens,
        };
    }

    const contextBudgetPatch: NonNullable<AgentExecutionConfig["contextBudget"]> = {};

    if (tokenLimits.maxContextTokens !== undefined) {
        const baselineContextWindow =
            args.executionConfig?.contextBudget?.contextWindowTokens ??
            DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget.contextWindowTokens;
        const nextContextWindow = Math.min(baselineContextWindow, tokenLimits.maxContextTokens);
        if (nextContextWindow !== baselineContextWindow) {
            contextBudgetPatch.contextWindowTokens = nextContextWindow;
        }
    }

    if (tokenLimits.maxOutputTokens !== undefined) {
        const baselineReserveOutputCap =
            args.executionConfig?.contextBudget?.reserveOutputTokensCap ??
            DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget.reserveOutputTokensCap;
        const nextReserveOutputCap = Math.min(baselineReserveOutputCap, tokenLimits.maxOutputTokens);
        if (nextReserveOutputCap !== baselineReserveOutputCap) {
            contextBudgetPatch.reserveOutputTokensCap = nextReserveOutputCap;
        }

        const baselineDownshifts =
            args.executionConfig?.contextBudget?.outputTokenDownshifts ??
            DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget.outputTokenDownshifts;
        const nextDownshifts = normalizeDownshiftsWithinLimit(
            baselineDownshifts,
            tokenLimits.maxOutputTokens,
        );
        if (!areNumericArraysEqual(nextDownshifts, baselineDownshifts)) {
            contextBudgetPatch.outputTokenDownshifts = nextDownshifts;
        }
    }

    if (Object.keys(contextBudgetPatch).length > 0) {
        executionConfig = {
            ...(args.executionConfig ?? {}),
            contextBudget: {
                ...(args.executionConfig?.contextBudget ?? {}),
                ...contextBudgetPatch,
            },
        };
    }

    return {
        modelParams,
        executionConfig,
        tokenLimits,
    };
};

export const normalizeProviderIdToDefaultApiKeyEnvName = (providerId: string): string => {
    const normalizedProviderId = providerId
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return `${normalizedProviderId || "PROVIDER"}_API_KEY`;
};

export const resolveProviderApiKey = (
    providerId: string,
    provider: AgentProviderConfig,
    env: NodeJS.ProcessEnv = process.env,
): string => {
    const explicitEnvName = trimToUndefined(provider.api_key_env);
    const implicitEnvName = normalizeProviderIdToDefaultApiKeyEnvName(providerId);

    const fromExplicitEnv =
        explicitEnvName ? trimToUndefined(env[explicitEnvName]) : undefined;
    if (fromExplicitEnv) return fromExplicitEnv;

    const fromImplicitEnv = trimToUndefined(env[implicitEnvName]);
    if (fromImplicitEnv) return fromImplicitEnv;

    const fromConfig = trimToUndefined(provider.api_key);
    if (fromConfig) return fromConfig;

    const hints = [
        explicitEnvName ? `env ${explicitEnvName}` : undefined,
        `env ${implicitEnvName}`,
        "providers[].api_key",
    ].filter(Boolean).join(", ");
    throw new Error(
        `Missing API key for provider '${providerId}'. Configure one of: ${hints}`,
    );
};

const createOpenAICompatibleLanguageModel = (
    selection: ResolvedRuntimeProviderSelection,
    providerName: string,
    defaultBaseURL?: string,
) => {
    const baseURL = resolveOpenAICompatibleProviderBaseURL(
        selection.providerId,
        selection.provider,
        defaultBaseURL,
    );
    if (!baseURL) {
        throw new Error(
            `provider '${selection.providerId}' requires providers[].base_url`,
        );
    }

    const provider = createOpenAICompatible({
        name: providerName,
        baseURL,
        apiKey: selection.apiKey,
        headers: selection.provider.headers,
    });

    return provider(selection.modelId);
};

export const isOpenAICompatibleProvider = (providerId: string): boolean =>
    OPENAI_COMPATIBLE_PROVIDER_IDS.has(providerId);

export const resolveOpenAICompatibleProviderBaseURL = (
    providerId: string,
    provider: Pick<AgentProviderConfig, "base_url">,
    overrideDefaultBaseURL?: string,
): string | undefined =>
    provider.base_url ??
    overrideDefaultBaseURL ??
    OPENAI_COMPATIBLE_DEFAULT_BASE_URLS[providerId];

const PROVIDER_BUILDERS: Record<string, ProviderModelBuilder> = {
    deepseek: ({ apiKey, modelId }) =>
        createDeepSeek({
            apiKey,
        })(modelId),
    volcengine: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "volcengine",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.volcengine_coding,
        ),
    openrouter: ({ provider, modelId, apiKey }) =>
        createOpenRouter({
            apiKey,
            baseURL: provider.base_url,
            headers: provider.headers,
            compatibility: "strict",
        })(modelId),
    "openai-compatible": (selection) =>
        createOpenAICompatibleLanguageModel(selection, "openai-compatible"),
    openai: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "openai",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.openai,
        ),
    siliconflow: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "siliconflow",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.siliconflow,
        ),
    moonshot: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "moonshot",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.moonshot,
        ),
    dashscope: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "dashscope",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.dashscope,
        ),
    groq: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "groq",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.groq,
        ),
    together: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "together",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.together,
        ),
    xai: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "xai",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.xai,
        ),
    ollama: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "ollama",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.ollama,
        ),
};

export const parseAgentModelRef = (ref: string): ParsedAgentModelRef => {
    const separatorIndex = ref.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex >= ref.length - 1) {
        throw new Error(
            "agent.model must be in '<provider_id>/<model>' format",
        );
    }

    return {
        providerId: ref.slice(0, separatorIndex),
        modelId: ref.slice(separatorIndex + 1),
    };
};

export const resolveSelectedProvider = (
    config: AgentConfig,
): ResolvedProviderSelection => {
    const agentModel = config.agent?.model;
    if (typeof agentModel !== "string" || agentModel.trim() === "") {
        throw new Error("agent.model must be a non-empty string");
    }

    const providers = config.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
        throw new Error("providers must be a non-empty array");
    }

    const { providerId, modelId } = parseAgentModelRef(agentModel);
    const provider = providers.find((item) => item.provider_id === providerId);
    if (!provider) {
        throw new Error(
            `agent.model references unknown provider_id: ${providerId}`,
        );
    }

    if (provider.enabled === false) {
        throw new Error(
            `agent.model references disabled provider_id: ${providerId}`,
        );
    }

    if (provider.model !== modelId) {
        throw new Error(
            "agent.model model part does not match providers[i].model",
        );
    }

    return {
        providerId,
        modelId,
        provider,
    };
};

export const createLanguageModelFromAgentConfig = (
    config: AgentConfig,
    env: NodeJS.ProcessEnv = process.env,
): LanguageModelV3 => {
    const selection = resolveSelectedProvider(config);
    const runtimeSelection: ResolvedRuntimeProviderSelection = {
        ...selection,
        apiKey: resolveProviderApiKey(selection.providerId, selection.provider, env),
    };
    const builder = PROVIDER_BUILDERS[selection.providerId];

    if (!builder) {
        const supported = Object.keys(PROVIDER_BUILDERS).sort().join(", ");
        throw new Error(
            `Unsupported provider_id: ${selection.providerId}. Supported providers: ${supported}`,
        );
    }

    return builder(runtimeSelection);
};
