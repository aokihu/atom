import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type { AgentConfig, AgentProviderConfig } from "../../../types/agent";

export type ParsedAgentModelRef = {
    providerId: string;
    modelId: string;
};

export type ResolvedProviderSelection = {
    providerId: string;
    modelId: string;
    provider: AgentProviderConfig;
};

type ProviderModelBuilder = (
    selection: ResolvedProviderSelection,
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

const createOpenAICompatibleLanguageModel = (
    selection: ResolvedProviderSelection,
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
        apiKey: selection.provider.api_key,
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
    deepseek: ({ provider, modelId }) =>
        createDeepSeek({
            apiKey: provider.api_key,
        })(modelId),
    volcengine: (selection) =>
        createOpenAICompatibleLanguageModel(
            selection,
            "volcengine",
            OPENAI_COMPATIBLE_DEFAULT_BASE_URLS.volcengine_coding,
        ),
    openrouter: ({ provider, modelId }) =>
        createOpenRouter({
            apiKey: provider.api_key,
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
): LanguageModelV3 => {
    const selection = resolveSelectedProvider(config);
    const builder = PROVIDER_BUILDERS[selection.providerId];

    if (!builder) {
        const supported = Object.keys(PROVIDER_BUILDERS).sort().join(", ");
        throw new Error(
            `Unsupported provider_id: ${selection.providerId}. Supported providers: ${supported}`,
        );
    }

    return builder(selection);
};
