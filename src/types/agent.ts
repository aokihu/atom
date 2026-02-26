export type AgentMeta = {
  name: string;
  [key: string]: unknown;
};

export type AgentRuntimeConfig = {
  name?: string;
  model: string;
  params?: AgentModelParams;
  execution?: AgentExecutionConfig;
};

export type AgentExecutionConfig = {
  maxModelStepsPerRun?: number;
  autoContinueOnStepLimit?: boolean;
  maxToolCallsPerTask?: number;
  maxContinuationRuns?: number;
  maxModelStepsPerTask?: number;
  continueWithoutAdvancingContextRound?: boolean;
};

export type ResolvedAgentExecutionConfig = {
  maxModelStepsPerRun: number;
  autoContinueOnStepLimit: boolean;
  maxToolCallsPerTask: number;
  maxContinuationRuns: number;
  maxModelStepsPerTask: number;
  continueWithoutAdvancingContextRound: boolean;
};

export const DEFAULT_AGENT_EXECUTION_CONFIG: ResolvedAgentExecutionConfig = {
  maxModelStepsPerRun: 10,
  autoContinueOnStepLimit: true,
  maxToolCallsPerTask: 40,
  maxContinuationRuns: 5,
  maxModelStepsPerTask: 80,
  continueWithoutAdvancingContextRound: true,
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
  todo?: AgentPermissionRules;
  cp?: AgentPermissionRules;
  mv?: AgentPermissionRules;
  git?: AgentPermissionRules;
  bash?: AgentPermissionRules;
  background?: AgentPermissionRules;
  webfetch?: AgentPermissionRules;
};

export type MCPHttpTransportConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type MCPStdioTransportConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type MCPServerTransportConfig = MCPHttpTransportConfig | MCPStdioTransportConfig;

export type MCPServerConfig = {
  id: string;
  enabled?: boolean;
  transport: MCPServerTransportConfig;
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

export type ContextMemoryTier = "core" | "working" | "ephemeral";

export type ContextMemoryBlock = {
  id: string;
  type: string;
  decay: number;
  confidence: number;
  round: number;
  tags: string[];
  content: string;
  [key: string]: unknown;
};

export type AgentContextMemory = {
  core: ContextMemoryBlock[];
  working: ContextMemoryBlock[];
  ephemeral: ContextMemoryBlock[];
};

export type AgentContextRuntime = {
  round: number;
  workspace: string;
  datetime: string;
  startup_at: number;
};

export type AgentContext = {
  [key: string]: unknown;
  version: number;
  runtime: AgentContextRuntime;
  memory: AgentContextMemory;
};
