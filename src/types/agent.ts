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

export type AgentIntentGuardDetector = "model" | "heuristic";

export type AgentIntentGuardBrowserPolicyConfig = {
  noFallback?: boolean;
  networkAdjacentOnly?: boolean;
  failTaskIfUnmet?: boolean;
};

export type AgentIntentGuardConfig = {
  enabled?: boolean;
  detector?: AgentIntentGuardDetector;
  softBlockAfter?: number;
  browser?: AgentIntentGuardBrowserPolicyConfig;
};

export type AgentExecutionConfig = {
  maxModelStepsPerRun?: number;
  autoContinueOnStepLimit?: boolean;
  maxToolCallsPerTask?: number;
  maxContinuationRuns?: number;
  maxModelStepsPerTask?: number;
  continueWithoutAdvancingContextRound?: boolean;
  intentGuard?: AgentIntentGuardConfig;
};

export type ResolvedAgentIntentGuardBrowserPolicyConfig = {
  noFallback: boolean;
  networkAdjacentOnly: boolean;
  failTaskIfUnmet: boolean;
};

export type ResolvedAgentIntentGuardConfig = {
  enabled: boolean;
  detector: AgentIntentGuardDetector;
  softBlockAfter: number;
  browser: ResolvedAgentIntentGuardBrowserPolicyConfig;
};

export type ResolvedAgentExecutionConfig = {
  maxModelStepsPerRun: number;
  autoContinueOnStepLimit: boolean;
  maxToolCallsPerTask: number;
  maxContinuationRuns: number;
  maxModelStepsPerTask: number;
  continueWithoutAdvancingContextRound: boolean;
  intentGuard: ResolvedAgentIntentGuardConfig;
};

export const DEFAULT_AGENT_EXECUTION_CONFIG: ResolvedAgentExecutionConfig = {
  maxModelStepsPerRun: 10,
  autoContinueOnStepLimit: true,
  maxToolCallsPerTask: 40,
  maxContinuationRuns: 5,
  maxModelStepsPerTask: 80,
  continueWithoutAdvancingContextRound: true,
  intentGuard: {
    enabled: true,
    detector: "model",
    softBlockAfter: 2,
    browser: {
      noFallback: true,
      networkAdjacentOnly: true,
      failTaskIfUnmet: true,
    },
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
  api_key?: string;
  api_key_env?: string;
  enabled?: boolean;
  base_url?: string;
  headers?: Record<string, string>;
};

export type TelegramTransportType = "polling" | "webhook";

export type TelegramTransportConfig = {
  type?: TelegramTransportType;
  pollingIntervalMs?: number;
  longPollTimeoutSec?: number;
  dropPendingUpdatesOnStart?: boolean;
  webhookPath?: string;
  webhookSecretToken?: string;
};

export type TelegramMessageParseMode = "MarkdownV2" | "plain";

export type TelegramMessageConfig = {
  parseMode?: TelegramMessageParseMode;
  chunkSize?: number;
};

export type TelegramConfig = {
  botToken?: string;
  allowedChatId: string;
  transport?: TelegramTransportConfig;
  message?: TelegramMessageConfig;
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
  memory?: AgentPermissionRules;
  cp?: AgentPermissionRules;
  mv?: AgentPermissionRules;
  git?: AgentPermissionRules;
  bash?: AgentPermissionRules;
  background?: AgentPermissionRules;
  webfetch?: AgentPermissionRules;
};

export type PersistentMemorySearchMode = "auto" | "fts" | "like";

export type PersistentMemoryConfig = {
  enabled?: boolean;
  autoRecall?: boolean;
  autoCapture?: boolean;
  maxRecallItems?: number;
  maxRecallLongtermItems?: number;
  minCaptureConfidence?: number;
  searchMode?: PersistentMemorySearchMode;
  tagging?: {
    reuseProbabilityThreshold?: number;
    placeholderSummaryMaxLen?: number;
    reactivatePolicy?: {
      enabled?: boolean;
      hitCountThreshold?: number;
      windowHours?: number;
    };
    scheduler?: {
      enabled?: boolean;
      adaptive?: boolean;
      baseIntervalMinutes?: number;
      minIntervalMinutes?: number;
      maxIntervalMinutes?: number;
      jitterRatio?: number;
    };
  };
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

export type AgentTuiConfig = {
  theme?: string;
};

export type AgentConfig = {
  agent?: AgentRuntimeConfig;
  providers?: AgentProviderConfig[];
  permissions?: AgentToolsPermission;
  memory?: {
    persistent?: PersistentMemoryConfig;
  };
  mcp?: MCPConfig;
  tui?: AgentTuiConfig;
  telegram?: TelegramConfig;
};

export type ContextMemoryTier = "core" | "working" | "ephemeral" | "longterm";

export type ContextMemoryBlockStatus = "open" | "done" | "failed" | "cancelled";

export type ContextMemoryBlock = {
  id: string;
  type: string;
  decay: number;
  confidence: number;
  round: number;
  tags: string[];
  content: string;
  content_state?: "active" | "tag_ref";
  tag_id?: string;
  tag_summary?: string;
  rehydrated_at?: number;
  status?: ContextMemoryBlockStatus;
  task_id?: string;
  closed_at?: number;
  [key: string]: unknown;
};

export type AgentContextMemory = {
  core: ContextMemoryBlock[];
  working: ContextMemoryBlock[];
  ephemeral: ContextMemoryBlock[];
  longterm: ContextMemoryBlock[];
};

export type AgentContextRuntime = {
  round: number;
  workspace: string;
  datetime: string;
  startup_at: number;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cumulative_total_tokens?: number;
    reasoning_tokens?: number;
    cached_input_tokens?: number;
    source: "ai-sdk";
    updated_at: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type AgentContextTodoProgress = {
  summary: string;
  total: number;
  step: number;
  cursor?: AgentContextTodoCursor | null;
};

export type AgentContextTodoCursorPhase =
  | "planning"
  | "doing"
  | "verifying"
  | "blocked";

export type AgentContextTodoCursorNext =
  | "none"
  | "todo_list"
  | "todo_add"
  | "todo_update"
  | "todo_complete"
  | "todo_reopen"
  | "todo_remove"
  | "todo_clear_done";

export type AgentContextTodoCursor = {
  v: 1;
  phase: AgentContextTodoCursorPhase;
  next: AgentContextTodoCursorNext;
  targetId: number | null;
  note?: string;
};

export type AgentContext = {
  [key: string]: unknown;
  version: number;
  runtime: AgentContextRuntime;
  memory: AgentContextMemory;
  todo?: AgentContextTodoProgress;
};

export type ContextProjectionDropReason =
  | "working_status_terminal"
  | "threshold_decay"
  | "threshold_confidence"
  | "expired_by_round"
  | "over_max_items"
  | "invalid_block";

export type ContextProjectionCounts = Record<ContextMemoryTier, number>;

export type ContextProjectionDroppedSample = {
  tier: ContextMemoryTier;
  id?: string;
  type?: string;
};

export type ContextProjectionDebug = {
  round: number;
  rawCounts: ContextProjectionCounts;
  injectedCounts: ContextProjectionCounts;
  droppedByReason: Record<ContextProjectionDropReason, number>;
  droppedSamples: Partial<Record<ContextProjectionDropReason, ContextProjectionDroppedSample[]>>;
};

export type AgentContextProjectionSnapshot = {
  context: AgentContext;
  injectedContext: AgentContext;
  projectionDebug: ContextProjectionDebug;
};
