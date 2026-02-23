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

export type MCPHttpTransportConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type MCPServerConfig = {
  id: string;
  enabled?: boolean;
  transport: MCPHttpTransportConfig;
};

export type MCPConfig = {
  servers?: MCPServerConfig[];
};

export type AgentConfig = {
  tools?: AgentToolsConfig;
  mcp?: MCPConfig;
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
