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
  read_email?: AgentPermissionRules;
  ls?: AgentPermissionRules;
  tree?: AgentPermissionRules;
  ripgrep?: AgentPermissionRules;
  write?: AgentPermissionRules;
  webfetch?: AgentPermissionRules;
  send_email?: AgentPermissionRules;
};

export type AgentConfig = {
  tools?: AgentToolsConfig;
};

export type AgentContext = {
  [key: string]: any;
  runtime: {
    round: number;
    workspace: string;
    datetime: string;
    startup_at: number;
  };
};
