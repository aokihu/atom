import { parse, resolve } from "node:path";
import type { AgentConfig } from "../../../types/agent";
import { BUILTIN_TOOL_CONFIG_SECTIONS } from "./constants";

export type NormalizedAgentConfig = AgentConfig;

const escapeRegexText = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cloneConfig = (config: AgentConfig): AgentConfig => structuredClone(config);

export const expandPathVariables = (
  config: AgentConfig,
  workspace: string,
): AgentConfig => {
  const normalizedConfig = cloneConfig(config);
  const tools = normalizedConfig.tools;

  if (!tools) {
    return normalizedConfig;
  }

  const workspacePath = resolve(workspace);
  const rootPath = parse(workspacePath).root;
  const workspaceRegexText = escapeRegexText(workspacePath);
  const rootRegexText = escapeRegexText(rootPath);

  for (const section of BUILTIN_TOOL_CONFIG_SECTIONS) {
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

  return normalizedConfig;
};
