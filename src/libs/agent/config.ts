import { parse, resolve } from "node:path";
import type { AgentConfig } from "../../types/agent";

const AGENT_CONFIG_FILENAME = "agent.config.json";

const ensureStringArray = (value: unknown, keyPath: string) => {
  if (value === undefined) return;

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${keyPath} must be an array of string`);
  }
};

const validateConfig = (config: AgentConfig) => {
  const tools = config.tools;
  if (tools === undefined) return;

  const sections: Array<"read" | "ls" | "tree" | "ripgrep" | "write" | "webfetch"> = [
    "read",
    "ls",
    "tree",
    "ripgrep",
    "write",
    "webfetch",
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

const escapeRegexText = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const expandPathVariables = (config: AgentConfig, workdir: string): AgentConfig => {
  const tools = config.tools;
  if (!tools) {
    return config;
  }

  const workspacePath = resolve(workdir);
  const rootPath = parse(workspacePath).root;
  const workspaceRegexText = escapeRegexText(workspacePath);
  const rootRegexText = escapeRegexText(rootPath);

  const sections: Array<"read" | "ls" | "tree" | "ripgrep" | "write" | "webfetch"> = [
    "read",
    "ls",
    "tree",
    "ripgrep",
    "write",
    "webfetch",
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
  workdir = process.cwd(),
): Promise<AgentConfig> => {
  const filepath = resolve(workdir, AGENT_CONFIG_FILENAME);
  const file = Bun.file(filepath);

  if (!(await file.exists())) {
    return {};
  }

  const content = await file.text();
  let rawConfig: unknown;

  try {
    rawConfig = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${AGENT_CONFIG_FILENAME}`);
  }

  if (typeof rawConfig !== "object" || rawConfig === null) {
    throw new Error(`${AGENT_CONFIG_FILENAME} must be a JSON object`);
  }

  const config = expandPathVariables(rawConfig as AgentConfig, workdir);
  validateConfig(config);
  return config;
};
