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

const validateConfig = (config: AgentConfig) => {
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
