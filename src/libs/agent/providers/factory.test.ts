import { describe, expect, test } from "bun:test";

import {
  createLanguageModelFromAgentConfig,
  normalizeProviderIdToDefaultApiKeyEnvName,
  parseAgentModelRef,
  resolveProviderApiKey,
  resolveSelectedProvider,
} from "./factory";

const createConfig = () => ({
  agent: {
    name: "Atom",
    model: "deepseek/deepseek-chat",
  },
  providers: [
    {
      provider_id: "deepseek",
      model: "deepseek-chat",
      api_key: "test-key",
      enabled: true,
    },
  ],
});

describe("provider factory", () => {
  test("normalizeProviderIdToDefaultApiKeyEnvName converts provider id to env var name", () => {
    expect(normalizeProviderIdToDefaultApiKeyEnvName("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(normalizeProviderIdToDefaultApiKeyEnvName("openai-compatible")).toBe("OPENAI_COMPATIBLE_API_KEY");
  });

  test("resolveProviderApiKey prefers explicit env var over implicit env var and config value", () => {
    expect(
      resolveProviderApiKey(
        "deepseek",
        {
          provider_id: "deepseek",
          model: "deepseek-chat",
          api_key: "config-key",
          api_key_env: "DEEPSEEK_PRIMARY_KEY",
        },
        {
          DEEPSEEK_PRIMARY_KEY: "explicit-env",
          DEEPSEEK_API_KEY: "implicit-env",
        },
      ),
    ).toBe("explicit-env");
  });

  test("resolveProviderApiKey uses implicit normalized env var when explicit env var is absent", () => {
    expect(
      resolveProviderApiKey(
        "openai-compatible",
        {
          provider_id: "openai-compatible",
          model: "foo",
        },
        {
          OPENAI_COMPATIBLE_API_KEY: "normalized-env",
        },
      ),
    ).toBe("normalized-env");
  });

  test("resolveProviderApiKey throws when no api key source exists", () => {
    expect(() =>
      resolveProviderApiKey(
        "deepseek",
        {
          provider_id: "deepseek",
          model: "deepseek-chat",
        },
        {},
      ),
    ).toThrow("Missing API key for provider 'deepseek'");
  });

  test("parseAgentModelRef parses provider and model", () => {
    expect(parseAgentModelRef("deepseek/deepseek-chat")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-chat",
    });
  });

  test("parseAgentModelRef keeps extra slashes in model", () => {
    expect(parseAgentModelRef("openrouter/google/gemini-2.5-flash")).toEqual({
      providerId: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
  });

  test("resolveSelectedProvider rejects missing provider", () => {
    expect(() =>
      resolveSelectedProvider({
        ...createConfig(),
        agent: {
          name: "Atom",
          model: "openrouter/google/gemini-2.5-flash",
        },
      }),
    ).toThrow("agent.model references unknown provider_id: openrouter");
  });

  test("resolveSelectedProvider rejects disabled provider", () => {
    expect(() =>
      resolveSelectedProvider({
        ...createConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key: "test-key",
            enabled: false,
          },
        ],
      }),
    ).toThrow("agent.model references disabled provider_id: deepseek");
  });

  test("createLanguageModelFromAgentConfig rejects unsupported provider", () => {
    expect(() =>
      createLanguageModelFromAgentConfig({
        agent: {
          name: "Atom",
          model: "mock/model-a",
        },
        providers: [
          {
            provider_id: "mock",
            model: "model-a",
            api_key: "test-key",
          },
        ],
      }),
    ).toThrow("Unsupported provider_id: mock");
  });

  test("createLanguageModelFromAgentConfig builds openrouter model", () => {
    const model = createLanguageModelFromAgentConfig({
      agent: {
        name: "Atom",
        model: "openrouter/openai/gpt-4o-mini",
      },
      providers: [
        {
          provider_id: "openrouter",
          model: "openai/gpt-4o-mini",
          api_key: "test-key",
        },
      ],
    });

    expect(model).toBeDefined();
  });

  test("createLanguageModelFromAgentConfig builds openai-compatible alias model", () => {
    const model = createLanguageModelFromAgentConfig({
      agent: {
        name: "Atom",
        model: "openai/gpt-4o-mini",
      },
      providers: [
        {
          provider_id: "openai",
          model: "gpt-4o-mini",
          api_key: "test-key",
        },
      ],
    });

    expect(model).toBeDefined();
  });

  test("createLanguageModelFromAgentConfig requires base_url for generic openai-compatible", () => {
    expect(() =>
      createLanguageModelFromAgentConfig({
        agent: {
          name: "Atom",
          model: "openai-compatible/my-model",
        },
        providers: [
          {
            provider_id: "openai-compatible",
            model: "my-model",
            api_key: "test-key",
          },
        ],
      }),
    ).toThrow("provider 'openai-compatible' requires providers[].base_url");
  });

  test("createLanguageModelFromAgentConfig builds deepseek model", () => {
    const model = createLanguageModelFromAgentConfig(createConfig());
    expect(model).toBeDefined();
  });

  test("createLanguageModelFromAgentConfig accepts provider key from env by explicit api_key_env", () => {
    const model = createLanguageModelFromAgentConfig(
      {
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
        },
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key_env: "DEEPSEEK_API_KEY_CUSTOM",
          },
        ],
      },
      {
        DEEPSEEK_API_KEY_CUSTOM: "env-key",
      },
    );

    expect(model).toBeDefined();
  });

  test("createLanguageModelFromAgentConfig accepts provider key from normalized env var fallback", () => {
    const model = createLanguageModelFromAgentConfig(
      {
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
        },
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
          },
        ],
      },
      {
        DEEPSEEK_API_KEY: "env-key",
      },
    );

    expect(model).toBeDefined();
  });
});
