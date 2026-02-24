import { describe, expect, test } from "bun:test";

import {
  createLanguageModelFromAgentConfig,
  parseAgentModelRef,
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
});
