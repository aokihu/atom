export type AgentMeta = {
  name: string;
  [key: string]: unknown;
};

export type AgentPermissionRules = {
  allow?: string[];
  deny?: string[];
};

export type AgentToolsConfig = {
  read?: AgentPermissionRules;
  write?: AgentPermissionRules;
  webfetch?: AgentPermissionRules;
};

export type AgentConfig = {
  tools?: AgentToolsConfig;
};
