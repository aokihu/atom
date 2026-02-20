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
  ls?: AgentPermissionRules;
  tree?: AgentPermissionRules;
  ripgrep?: AgentPermissionRules;
  write?: AgentPermissionRules;
  webfetch?: AgentPermissionRules;
};

export type AgentConfig = {
  tools?: AgentToolsConfig;
};

export type AgentContext = {
  [key: string]: any;
  runtime: {
    round: number;
    datetime: string;
    startup_at: number;
  };
};
