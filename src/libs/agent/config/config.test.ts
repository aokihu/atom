import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadAgentConfig } from "../config";
import { expandPathVariables } from "./normalizer";
import { validateAgentConfig } from "./validator";

const createValidConfig = () => ({
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

describe("agent config", () => {
  test("expandPathVariables returns a cloned config and expands placeholders", () => {
    const raw = {
      permissions: {
        read: {
          allow: ["^{workspace}/.*", "^{root}Users/.*"],
          deny: [],
        },
      },
    };

    const expanded = expandPathVariables(raw, "/Users/me/project");

    expect(expanded).not.toBe(raw);
    expect(raw.permissions?.read?.allow?.[0]).toBe("^{workspace}/.*");
    expect(expanded.permissions?.read?.allow?.[0]).toContain("^/Users/me/project");
    expect(expanded.permissions?.read?.allow?.[1]).toContain("^/");
  });

  test("validateAgentConfig rejects invalid regex", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        permissions: {
          read: {
            allow: ["["],
          },
        },
      }),
    ).toThrow("Invalid regex in permissions.read");
  });

  test("validateAgentConfig accepts minimal new config", () => {
    expect(() => validateAgentConfig(createValidConfig())).not.toThrow();
  });

  test("validateAgentConfig accepts permissions.background rules", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        permissions: {
          background: {
            allow: ["^/Users/me/work/.*"],
            deny: ["^/Users/me/work/secrets/.*"],
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts agent.params", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          params: {
            temperature: 0.2,
            topP: 0.9,
            maxOutputTokens: 2048,
            stopSequences: ["</END>"],
            seed: 42,
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts agent.execution", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            maxModelStepsPerRun: 12,
            autoContinueOnStepLimit: true,
            maxToolCallsPerTask: 50,
            maxContinuationRuns: 6,
            maxModelStepsPerTask: 90,
            continueWithoutAdvancingContextRound: true,
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts agent.execution v2 extensions", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            contextV2: {
              enabled: true,
              apiDualMode: true,
              injectLiteOnly: true,
            },
            inputPolicy: {
              enabled: true,
              autoCompress: true,
              maxInputTokens: 10000,
              summarizeTargetTokens: 1600,
            },
            contextBudget: {
              enabled: true,
              contextWindowTokens: 131072,
              reserveOutputTokensMax: 2048,
              safetyMarginRatio: 0.12,
              safetyMarginMinTokens: 6000,
              outputStepDownTokens: [2048, 1024, 512],
            },
            overflowPolicy: {
              isolateTaskOnContextOverflow: true,
            },
            intentGuard: {
              enabled: true,
              detector: {
                mode: "hybrid",
                timeoutMs: 600,
                modelMaxOutputTokens: 80,
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects invalid agent.execution.intentGuard.detector", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            intentGuard: {
              detector: {
                mode: "invalid-mode",
              } as any,
            },
          },
        },
      }),
    ).toThrow("agent.execution.intentGuard.detector.mode must be one of");
  });

  test("validateAgentConfig rejects invalid agent.execution.maxToolCallsPerTask", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            maxToolCallsPerTask: 0,
          },
        },
      }),
    ).toThrow("agent.execution.maxToolCallsPerTask must be a positive integer");
  });

  test("validateAgentConfig rejects deprecated agentName", () => {
    const config = createValidConfig() as any;
    config.agentName = "Atom";

    expect(() =>
      validateAgentConfig(config),
    ).toThrow("agentName is deprecated; use agent.name");
  });

  test("validateAgentConfig rejects invalid agent.model format", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek",
        },
      }),
    ).toThrow("agent.model must be in '<provider_id>/<model>' format");
  });

  test("validateAgentConfig rejects missing agent.model", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
        } as any,
      }),
    ).toThrow("agent.model must be a non-empty string");
  });

  test("validateAgentConfig rejects invalid agent.params type", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          params: "invalid" as any,
        },
      }),
    ).toThrow("agent.params must be a JSON object");
  });

  test("validateAgentConfig rejects invalid agent.params.topP", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          params: {
            topP: 2,
          },
        },
      }),
    ).toThrow("agent.params.topP must be <= 1");
  });

  test("validateAgentConfig rejects invalid agent.params.temperature", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          params: {
            temperature: 3,
          },
        },
      }),
    ).toThrow("agent.params.temperature must be <= 2");
  });

  test("validateAgentConfig rejects invalid agent.params.stopSequences", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          params: {
            stopSequences: [123] as any,
          },
        },
      }),
    ).toThrow("agent.params.stopSequences must be an array of string");
  });

  test("validateAgentConfig rejects unknown provider reference", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "openrouter/deepseek-chat",
        },
      }),
    ).toThrow("agent.model references unknown provider_id: openrouter");
  });

  test("validateAgentConfig rejects provider model mismatch", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-reasoner",
            api_key: "test-key",
          },
        ],
      }),
    ).toThrow("agent.model model part does not match providers[i].model");
  });

  test("validateAgentConfig rejects duplicate provider ids", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key: "a",
          },
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key: "b",
          },
        ],
      }),
    ).toThrow("Duplicate provider_id: deepseek");
  });

  test("validateAgentConfig rejects empty providers", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [],
      }),
    ).toThrow("providers must be a non-empty array");
  });

  test("validateAgentConfig rejects invalid provider base_url", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key: "test-key",
            base_url: "not-a-url",
          },
        ],
      }),
    ).toThrow("providers[0].base_url is invalid URL");
  });

  test("validateAgentConfig rejects invalid provider headers", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key: "test-key",
            headers: { Authorization: 123 as any },
          },
        ],
      }),
    ).toThrow("providers[0].headers.Authorization must be a string");
  });

  test("validateAgentConfig accepts provider token limits", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key: "test-key",
            max_context_tokens: 131072,
            max_output_tokens: 8192,
          },
        ],
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects duplicate MCP server ids", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "memory",
              transport: { type: "http", url: "http://localhost:8787/mcp" },
            },
            {
              id: "memory",
              transport: { type: "http", url: "http://localhost:8788/mcp" },
            },
          ],
        },
      }),
    ).toThrow("Duplicate MCP server id: memory");
  });

  test("validateAgentConfig rejects invalid MCP URL", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "memory",
              transport: { type: "http", url: "not-a-url" },
            },
          ],
        },
      }),
    ).toThrow("transport.url is invalid URL");
  });

  test("validateAgentConfig accepts stdio MCP transport with full fields", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "fs",
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
                env: {
                  NODE_ENV: "test",
                },
                cwd: "/tmp",
              },
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts memory.persistent pipeline", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        memory: {
          persistent: {
            enabled: true,
            storagePath: "{workspace}/.agent/persistent-memory.jsonl",
            walPath: "{workspace}/.agent/memory-queue.wal",
            recallLimit: 24,
            maxEntries: 4000,
            pipeline: {
              mode: "async_wal",
              recallTimeoutMs: 40,
              batchSize: 32,
              flushIntervalMs: 200,
              flushOnShutdownTimeoutMs: 3000,
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects stdio transport without command", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "fs",
              transport: {
                type: "stdio",
              } as any,
            },
          ],
        },
      }),
    ).toThrow("mcp.servers[0].transport.command must be a non-empty string");
  });

  test("validateAgentConfig rejects stdio args when not string[]", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "fs",
              transport: {
                type: "stdio",
                command: "npx",
                args: [123] as any,
              },
            },
          ],
        },
      }),
    ).toThrow("mcp.servers[0].transport.args must be an array of string");
  });

  test("validateAgentConfig rejects stdio env when values are not strings", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "fs",
              transport: {
                type: "stdio",
                command: "npx",
                env: {
                  PORT: 3000 as any,
                },
              },
            },
          ],
        },
      }),
    ).toThrow("mcp.servers[0].transport.env.PORT must be a string");
  });

  test("validateAgentConfig rejects stdio cwd when empty string", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        mcp: {
          servers: [
            {
              id: "fs",
              transport: {
                type: "stdio",
                command: "npx",
                cwd: "",
              },
            },
          ],
        },
      }),
    ).toThrow("mcp.servers[0].transport.cwd must be a non-empty string");
  });

  test("loadAgentConfig returns empty object when file does not exist", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-config-missing-"));
    await expect(loadAgentConfig({ workspace })).resolves.toEqual({});
  });

  test("loadAgentConfig rejects invalid JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-config-invalid-json-"));
    await writeFile(join(workspace, "agent.config.json"), "{invalid");

    await expect(loadAgentConfig({ workspace })).rejects.toThrow("Invalid JSON");
  });
});
