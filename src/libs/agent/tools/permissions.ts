import type { AgentPermissionRules, AgentToolsConfig } from "../../../types/agent";

const matchByRules = (target: string, rules?: AgentPermissionRules) => {
  if (!rules) {
    return true;
  }

  const denyPatterns = (rules.deny ?? []).map((item) => new RegExp(item));
  if (denyPatterns.some((regex) => regex.test(target))) {
    return false;
  }

  const allowPatterns = (rules.allow ?? []).map((item) => new RegExp(item));
  if (allowPatterns.length === 0) {
    return true;
  }

  return allowPatterns.some((regex) => regex.test(target));
};

export const canReadFile = (filepath: string, tools?: AgentToolsConfig) =>
  matchByRules(filepath, tools?.read);

export const canWriteFile = (filepath: string, tools?: AgentToolsConfig) =>
  matchByRules(filepath, tools?.write);

export const canVisitUrl = (url: string, tools?: AgentToolsConfig) =>
  matchByRules(url, tools?.webfetch);
