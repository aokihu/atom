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

  test("validateAgentConfig accepts permissions.todo rules", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        permissions: {
          todo: {
            allow: ["^/Users/me/work/.*"],
            deny: ["^/Users/me/work/private/.*"],
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts permissions.memory rules", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        permissions: {
          memory: {
            allow: ["^/Users/me/work/.*"],
            deny: ["^/Users/me/work/private/.*"],
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts tui.theme", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        tui: {
          theme: "nord",
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects non-object tui config", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        tui: "nord" as any,
      }),
    ).toThrow("tui must be a JSON object");
  });

  test("validateAgentConfig rejects empty tui.theme", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        tui: {
          theme: "   ",
        },
      }),
    ).toThrow("tui.theme must be a non-empty string");
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
            intentGuard: {
              enabled: true,
              detector: "model",
              softBlockAfter: 2,
              intents: {
                browser_access: {
                  enabled: true,
                  allowedFamilies: ["browser"],
                  softAllowedFamilies: ["network"],
                  softBlockAfter: 2,
                  minRequiredAttemptsBeforeSoftFallback: 3,
                  softFallbackOnlyOnRequiredFailure: true,
                  noFallback: true,
                  failTaskIfUnmet: true,
                  requiredSuccessFamilies: ["browser"],
                },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts agent.execution.intentGuard legacy browser config", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            intentGuard: {
              browser: {
                noFallback: true,
                networkAdjacentOnly: true,
                failTaskIfUnmet: true,
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects invalid agent.execution.intentGuard.softBlockAfter", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            intentGuard: {
              softBlockAfter: -1,
            },
          },
        },
      }),
    ).toThrow("agent.execution.intentGuard.softBlockAfter must be an integer in range 0..12");
  });

  test("validateAgentConfig rejects invalid intentGuard tool family", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            intentGuard: {
              intents: {
                code_edit: {
                  allowedFamilies: ["not_a_family"] as any,
                },
              },
            },
          },
        },
      }),
    ).toThrow(
      'agent.execution.intentGuard.intents.code_edit has unsupported family "not_a_family"',
    );
  });

  test("validateAgentConfig rejects invalid minRequiredAttemptsBeforeSoftFallback", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        agent: {
          name: "Atom",
          model: "deepseek/deepseek-chat",
          execution: {
            intentGuard: {
              intents: {
                browser_access: {
                  minRequiredAttemptsBeforeSoftFallback: 99,
                },
              },
            },
          },
        },
      }),
    ).toThrow(
      "agent.execution.intentGuard.intents.browser_access.minRequiredAttemptsBeforeSoftFallback must be an integer in range 0..12",
    );
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

  test("validateAgentConfig accepts memory.persistent config", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        memory: {
          persistent: {
            enabled: true,
            autoRecall: true,
            autoCapture: true,
            maxRecallItems: 6,
            minCaptureConfidence: 0.7,
            searchMode: "auto",
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig accepts all memory.persistent search modes", () => {
    for (const searchMode of ["auto", "fts", "like"] as const) {
      expect(() =>
        validateAgentConfig({
          ...createValidConfig(),
          memory: {
            persistent: {
              enabled: true,
              searchMode,
            },
          },
        }),
      ).not.toThrow();
    }
  });

  test("validateAgentConfig accepts memory.persistent.tagging config", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        memory: {
          persistent: {
            enabled: true,
            maxRecallLongtermItems: 12,
            tagging: {
              reuseProbabilityThreshold: 0.2,
              placeholderSummaryMaxLen: 120,
              reactivatePolicy: {
                enabled: true,
                hitCountThreshold: 3,
                windowHours: 48,
              },
              scheduler: {
                enabled: true,
                adaptive: true,
                baseIntervalMinutes: 15,
                minIntervalMinutes: 5,
                maxIntervalMinutes: 180,
                jitterRatio: 0.1,
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects invalid memory.persistent.maxRecallItems", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        memory: {
          persistent: {
            enabled: true,
            maxRecallItems: 13,
          },
        },
      }),
    ).toThrow("memory.persistent.maxRecallItems must be <= 12");
  });

  test("validateAgentConfig rejects invalid memory.persistent.minCaptureConfidence", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        memory: {
          persistent: {
            enabled: true,
            minCaptureConfidence: 2,
          },
        },
      }),
    ).toThrow("memory.persistent.minCaptureConfidence must be <= 1");
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

  test("validateAgentConfig accepts provider.api_key_env without provider.api_key", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key_env: "DEEPSEEK_API_KEY",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("validateAgentConfig rejects invalid provider.api_key_env", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        providers: [
          {
            provider_id: "deepseek",
            model: "deepseek-chat",
            api_key_env: "deepseek.api.key",
          },
        ],
      }),
    ).toThrow("providers[0].api_key_env must match /^[A-Z_][A-Z0-9_]*$/");
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

  test("validateAgentConfig rejects telegram config and asks for migration", () => {
    expect(() =>
      validateAgentConfig({
        ...createValidConfig(),
        telegram: {
          botToken: "bot-token",
          allowedChatId: "12345",
        },
      }),
    ).toThrow("telegram config has been removed");
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
