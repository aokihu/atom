import type { AgentConfig } from "../../../types/agent";
import { BUILTIN_TOOL_CONFIG_SECTIONS } from "./constants";

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

export const validateToolsConfig = (config: AgentConfig) => {
  const permissions = config.permissions;
  if (permissions === undefined) return;

  for (const section of BUILTIN_TOOL_CONFIG_SECTIONS) {
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

export const validateAgentConfig = (config: AgentConfig) => {
  ensureNonEmptyString(config.agentName, "agentName");
  validateToolsConfig(config);
  validateMcpConfig(config);
};
