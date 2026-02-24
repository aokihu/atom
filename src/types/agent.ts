export type AgentMeta = {
  name: string;
  [key: string]: unknown;
};

export type AgentRuntimeConfig = {
  name?: string;
  model: string;
  params?: AgentModelParams;
};

export type AgentModelParams = {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
};

export type AgentProviderConfig = {
  provider_id: string;
  model: string;
  api_key: string;
  enabled?: boolean;
  base_url?: string;
  headers?: Record<string, string>;
};

export type AgentPermissionRules = {
  allow?: string[];
  deny?: string[];
};

export type AgentToolsPermission = {
  read?: AgentPermissionRules;
  ls?: AgentPermissionRules;
  tree?: AgentPermissionRules;
  ripgrep?: AgentPermissionRules;
  write?: AgentPermissionRules;
  cp?: AgentPermissionRules;
  mv?: AgentPermissionRules;
  git?: AgentPermissionRules;
  webfetch?: AgentPermissionRules;
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
  agent?: AgentRuntimeConfig;
  providers?: AgentProviderConfig[];
  permissions?: AgentToolsPermission;
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
