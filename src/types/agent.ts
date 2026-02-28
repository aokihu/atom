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

export type AgentIntentDetectorMode = "heuristic" | "hybrid" | "model";

export type AgentIntentGuardDetectorConfig =
  | AgentIntentDetectorMode
  | {
      mode?: AgentIntentDetectorMode;
      timeoutMs?: number;
      modelMaxOutputTokens?: number;
    };

export type AgentExecutionContextV2Config = {
  enabled?: boolean;
  apiDualMode?: boolean;
  injectLiteOnly?: boolean;
};

export type AgentExecutionInputPolicyConfig = {
  enabled?: boolean;
  autoCompress?: boolean;
  maxInputTokens?: number;
  summarizeTargetTokens?: number;
};

export type AgentExecutionContextBudgetConfig = {
  enabled?: boolean;
  contextWindowTokens?: number;
  reserveOutputTokensMax?: number;
  safetyMarginRatio?: number;
  safetyMarginMinTokens?: number;
  outputStepDownTokens?: number[];
};

export type AgentExecutionOverflowPolicyConfig = {
  isolateTaskOnContextOverflow?: boolean;
};

export type AgentExecutionIntentGuardConfig = {
  enabled?: boolean;
  detector?: AgentIntentGuardDetectorConfig;
};

export type AgentExecutionConfig = {
  maxModelStepsPerRun?: number;
  autoContinueOnStepLimit?: boolean;
  maxToolCallsPerTask?: number;
  maxContinuationRuns?: number;
  maxModelStepsPerTask?: number;
  continueWithoutAdvancingContextRound?: boolean;
  contextV2?: AgentExecutionContextV2Config;
  inputPolicy?: AgentExecutionInputPolicyConfig;
  contextBudget?: AgentExecutionContextBudgetConfig;
  overflowPolicy?: AgentExecutionOverflowPolicyConfig;
  intentGuard?: AgentExecutionIntentGuardConfig;
};

export type ResolvedAgentExecutionContextV2Config = {
  enabled: boolean;
  apiDualMode: boolean;
  injectLiteOnly: boolean;
};

export type ResolvedAgentExecutionInputPolicyConfig = {
  enabled: boolean;
  autoCompress: boolean;
  maxInputTokens: number;
  summarizeTargetTokens: number;
};

export type ResolvedAgentExecutionContextBudgetConfig = {
  enabled: boolean;
  contextWindowTokens: number;
  reserveOutputTokensMax: number;
  safetyMarginRatio: number;
  safetyMarginMinTokens: number;
  outputStepDownTokens: number[];
};

export type ResolvedAgentExecutionOverflowPolicyConfig = {
  isolateTaskOnContextOverflow: boolean;
};

export type ResolvedAgentExecutionIntentGuardConfig = {
  enabled: boolean;
  detector: AgentIntentDetectorMode;
  detectorTimeoutMs: number;
  detectorModelMaxOutputTokens: number;
};

export type ResolvedAgentExecutionConfig = {
  maxModelStepsPerRun: number;
  autoContinueOnStepLimit: boolean;
  maxToolCallsPerTask: number;
  maxContinuationRuns: number;
  maxModelStepsPerTask: number;
  continueWithoutAdvancingContextRound: boolean;
  contextV2: ResolvedAgentExecutionContextV2Config;
  inputPolicy: ResolvedAgentExecutionInputPolicyConfig;
  contextBudget: ResolvedAgentExecutionContextBudgetConfig;
  overflowPolicy: ResolvedAgentExecutionOverflowPolicyConfig;
  intentGuard: ResolvedAgentExecutionIntentGuardConfig;
};

export const DEFAULT_AGENT_EXECUTION_CONFIG: ResolvedAgentExecutionConfig = {
  maxModelStepsPerRun: 10,
  autoContinueOnStepLimit: true,
  maxToolCallsPerTask: 40,
  maxContinuationRuns: 5,
  maxModelStepsPerTask: 80,
  continueWithoutAdvancingContextRound: true,
  contextV2: {
    enabled: true,
    apiDualMode: true,
    injectLiteOnly: true,
  },
  inputPolicy: {
    enabled: true,
    autoCompress: true,
    maxInputTokens: 12000,
    summarizeTargetTokens: 1800,
  },
  contextBudget: {
    enabled: true,
    contextWindowTokens: 131072,
    reserveOutputTokensMax: 2048,
    safetyMarginRatio: 0.12,
    safetyMarginMinTokens: 6000,
    outputStepDownTokens: [2048, 1024, 512],
  },
  overflowPolicy: {
    isolateTaskOnContextOverflow: true,
  },
  intentGuard: {
    enabled: true,
    detector: "hybrid",
    detectorTimeoutMs: 600,
    detectorModelMaxOutputTokens: 80,
  },
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
  max_context_tokens?: number;
  max_output_tokens?: number;
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

export type PersistentMemoryPipelineMode = "sync" | "async_wal";

export type PersistentMemoryPipelineConfig = {
  mode?: PersistentMemoryPipelineMode;
  recallTimeoutMs?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  flushOnShutdownTimeoutMs?: number;
};

export type PersistentMemoryConfig = {
  enabled?: boolean;
  storagePath?: string;
  walPath?: string;
  recallLimit?: number;
  maxEntries?: number;
  pipeline?: PersistentMemoryPipelineConfig;
};

export type MemoryConfig = {
  persistent?: PersistentMemoryConfig;
};

export type AgentConfig = {
  agent?: AgentRuntimeConfig;
  providers?: AgentProviderConfig[];
  permissions?: AgentToolsPermission;
  mcp?: MCPConfig;
  memory?: MemoryConfig;
};

export type ContextMemoryTier = "core" | "working" | "ephemeral" | "longterm";

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
  longterm: ContextMemoryBlock[];
};

export type RuntimeTokenUsage = {
  source?: string;
  updated_at?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  cumulative_total_tokens?: number;
};

export type RuntimeBudgetSnapshot = {
  estimated_input_tokens: number;
  input_budget: number;
  reserve_output_tokens: number;
  safety_margin_tokens: number;
  degrade_stage: string;
  output_limit_tokens: number;
};

export type AgentContextRuntime = {
  round: number;
  workspace: string;
  datetime: string;
  startup_at: number;
  token_usage?: RuntimeTokenUsage;
  budget?: RuntimeBudgetSnapshot;
  [key: string]: unknown;
};

export type ModelContextV2Runtime = {
  round: number;
  workspace: string;
  datetime: string;
  startup_at: number;
};

export type ModelContextV2Todo = {
  summary?: string;
  total?: number;
  step?: number;
  cursor?: number;
};

export type ModelContextV2ActiveTaskMeta = {
  id?: string;
  type?: string;
  status?: string;
  retries?: number;
  attempt?: number;
  execution?: Record<string, unknown>;
};

export type ModelContextV2 = {
  version: number;
  runtime: ModelContextV2Runtime;
  memory: AgentContextMemory;
  todo?: ModelContextV2Todo;
  active_task?: string | null;
  active_task_meta?: ModelContextV2ActiveTaskMeta | null;
  capabilities?: unknown;
};

export type AgentContext = {
  [key: string]: unknown;
  version: number;
  runtime: AgentContextRuntime;
  memory: AgentContextMemory;
};

export type ContextProjectionCounts = Record<ContextMemoryTier, number>;

export type ContextProjectionDebug = {
  round: number;
  rawCounts: ContextProjectionCounts;
  injectedCounts: ContextProjectionCounts;
  droppedByReason: Record<string, number>;
  droppedSamples?: Record<string, Array<{ tier: ContextMemoryTier; id: string; type: string }>>;
};

export type AgentContextProjectionSnapshot = {
  context: AgentContext;
  injectedContext: AgentContext;
  modelContext: ModelContextV2;
  projectionDebug?: ContextProjectionDebug;
};
