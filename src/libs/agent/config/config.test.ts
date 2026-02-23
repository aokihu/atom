import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadAgentConfig } from "../config";
import { expandPathVariables } from "./normalizer";
import { validateAgentConfig } from "./validator";

describe("agent config", () => {
  test("expandPathVariables returns a cloned config and expands placeholders", () => {
    const raw = {
      tools: {
        read: {
          allow: ["^{workspace}/.*", "^{root}Users/.*"],
          deny: [],
        },
      },
    };

    const expanded = expandPathVariables(raw, "/Users/me/project");

    expect(expanded).not.toBe(raw);
    expect(raw.tools?.read?.allow?.[0]).toBe("^{workspace}/.*");
    expect(expanded.tools?.read?.allow?.[0]).toContain("^/Users/me/project");
    expect(expanded.tools?.read?.allow?.[1]).toContain("^/");
  });

  test("validateAgentConfig rejects invalid regex", () => {
    expect(() =>
      validateAgentConfig({
        tools: {
          read: {
            allow: ["["],
          },
        },
      }),
    ).toThrow("Invalid regex in tools.read");
  });

  test("validateAgentConfig rejects duplicate MCP server ids", () => {
    expect(() =>
      validateAgentConfig({
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

