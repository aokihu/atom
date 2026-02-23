import { parse, resolve } from "node:path";
import type { AgentConfig } from "../../types/agent";

const AGENT_CONFIG_FILENAME = "agent.config.json";
type LoadAgentConfigOptions = {
  workspace: string;
  configPath?: string;
};

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

const validateToolsConfig = (config: AgentConfig) => {
  const tools = config.tools;
  if (tools === undefined) return;

  const sections: Array<
    | "read"
    | "read_email"
    | "ls"
    | "tree"
    | "ripgrep"
    | "write"
    | "webfetch"
    | "send_email"
  > = [
    "read",
    "read_email",
    "ls",
    "tree",
    "ripgrep",
    "write",
    "webfetch",
    "send_email",
  ];

  for (const section of sections) {
    const rule = tools[section];
    if (!rule) continue;

    ensureStringArray(rule.allow, `tools.${section}.allow`);
    ensureStringArray(rule.deny, `tools.${section}.deny`);

    for (const regexText of [...(rule.allow ?? []), ...(rule.deny ?? [])]) {
      try {
        new RegExp(regexText);
      } catch {
        throw new Error(`Invalid regex in tools.${section}: ${regexText}`);
      }
    }
  }
};

const validateMcpConfig = (config: AgentConfig) => {
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

    if (transport.type !== "http") {
      throw new Error(`${keyPath}.transport.type must be "http"`);
    }

    if (typeof transport.url !== "string" || transport.url.trim() === "") {
      throw new Error(`${keyPath}.transport.url must be a non-empty string`);
    }

    try {
      new URL(transport.url);
    } catch {
      throw new Error(`${keyPath}.transport.url is invalid URL`);
    }

    ensureStringRecord(transport.headers, `${keyPath}.transport.headers`);
  });
};

const validateConfig = (config: AgentConfig) => {
  validateToolsConfig(config);
  validateMcpConfig(config);
};

const escapeRegexText = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const expandPathVariables = (
  config: AgentConfig,
  workspace: string,
): AgentConfig => {
  const tools = config.tools;
  if (!tools) {
    return config;
  }

  const workspacePath = resolve(workspace);
  const rootPath = parse(workspacePath).root;
  const workspaceRegexText = escapeRegexText(workspacePath);
  const rootRegexText = escapeRegexText(rootPath);

  const sections: Array<
    | "read"
    | "read_email"
    | "ls"
    | "tree"
    | "ripgrep"
    | "write"
    | "webfetch"
    | "send_email"
  > = [
    "read",
    "read_email",
    "ls",
    "tree",
    "ripgrep",
    "write",
    "webfetch",
    "send_email",
  ];

  for (const section of sections) {
    const rule = tools[section];
    if (!rule) continue;

    rule.allow = rule.allow?.map((text) =>
      text
        .replaceAll("{workspace}", workspaceRegexText)
        .replaceAll("{root}", rootRegexText),
    );

    rule.deny = rule.deny?.map((text) =>
      text
        .replaceAll("{workspace}", workspaceRegexText)
        .replaceAll("{root}", rootRegexText),
    );
  }

  return config;
};

export const loadAgentConfig = async (
  options: LoadAgentConfigOptions,
): Promise<AgentConfig> => {
  const workspacePath = resolve(options.workspace);
  const filepath = options.configPath
    ? resolve(options.configPath)
    : resolve(workspacePath, AGENT_CONFIG_FILENAME);
  const file = Bun.file(filepath);

  if (!(await file.exists())) {
    return {};
  }

  const content = await file.text();
  let rawConfig: unknown;

  try {
    rawConfig = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${filepath}`);
  }

  if (typeof rawConfig !== "object" || rawConfig === null) {
    throw new Error(`${filepath} must be a JSON object`);
  }

  const config = expandPathVariables(rawConfig as AgentConfig, workspacePath);
  validateConfig(config);
  return config;
};
