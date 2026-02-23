import { resolve } from "node:path";
import type { AgentConfig } from "../../../types/agent";
import { AGENT_CONFIG_FILENAME } from "./constants";
import { expandPathVariables } from "./normalizer";
import { validateAgentConfig } from "./validator";

export type LoadAgentConfigOptions = {
  workspace: string;
  configPath?: string;
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
  validateAgentConfig(config);
  return config;
};

