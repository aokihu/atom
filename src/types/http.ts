import type { ModelMessage } from "ai";

import type { AgentContext, ContextProjectionDebug } from "./agent";
import type { TaskItem, TaskPriority } from "./task";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

export type ApiSuccessResponse<T> = {
  ok: true;
  data: T;
};

export type ApiErrorResponse = {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export type TaskSnapshot = Pick<
  TaskItem<string, string>,
  | "id"
  | "type"
  | "priority"
  | "status"
  | "input"
  | "result"
  | "error"
  | "retries"
  | "maxRetries"
  | "createAt"
  | "startedAt"
  | "finishedAt"
  | "parentId"
  | "metadata"
  | "cancellable"
>;

export type TaskOutputMessageCategory = "assistant" | "tool" | "other";

export type ToolDisplayPhase = "call" | "result";

export type ToolDisplayEnvelope = {
  version: 1;
  toolName: string;
  phase: ToolDisplayPhase;
  templateKey: string;
  data: Record<string, unknown>;
};

export type TaskOutputMessage =
  | {
      seq: number;
      createdAt: number;
      category: "assistant";
      type: "assistant.text";
      text: string;
      final: boolean;
      step?: number;
    }
  | {
      seq: number;
      createdAt: number;
      category: "tool";
      type: "tool.call";
      step?: number;
      toolCallId?: string;
      toolName: string;
      inputSummary?: string;
      inputDisplay?: ToolDisplayEnvelope;
    }
  | {
      seq: number;
      createdAt: number;
      category: "tool";
      type: "tool.result";
      step?: number;
      toolCallId?: string;
      toolName: string;
      ok: boolean;
      outputSummary?: string;
      errorMessage?: string;
      outputDisplay?: ToolDisplayEnvelope;
    }
  | {
      seq: number;
      createdAt: number;
      category: "other";
      type: "task.status" | "step.finish" | "task.finish" | "task.error";
      text: string;
      step?: number;
      finishReason?: string;
    };

export type TaskOutputMessageDraft =
  | {
      createdAt?: number;
      category: "assistant";
      type: "assistant.text";
      text: string;
      final: boolean;
      step?: number;
    }
  | {
      createdAt?: number;
      category: "tool";
      type: "tool.call";
      step?: number;
      toolCallId?: string;
      toolName: string;
      inputSummary?: string;
      inputDisplay?: ToolDisplayEnvelope;
    }
  | {
      createdAt?: number;
      category: "tool";
      type: "tool.result";
      step?: number;
      toolCallId?: string;
      toolName: string;
      ok: boolean;
      outputSummary?: string;
      errorMessage?: string;
      outputDisplay?: ToolDisplayEnvelope;
    }
  | {
      createdAt?: number;
      category: "other";
      type: "task.status" | "step.finish" | "task.finish" | "task.error";
      text: string;
      step?: number;
      finishReason?: string;
    };

export type TaskMessagesDelta = {
  items: TaskOutputMessage[];
  nextSeq: number;
  latestSeq: number;
};

export type CreateTaskRequest = {
  input: string;
  priority?: TaskPriority;
  type?: string;
};

export type CreateTaskResponse = {
  taskId: string;
  task: TaskSnapshot;
};

export type TaskStatusResponse = {
  task: TaskSnapshot;
  messages?: TaskMessagesDelta;
};

export type ForceAbortResponse = {
  abortedCurrent: boolean;
  clearedPendingCount: number;
  timestamp: number;
};

export type QueueStats = {
  size: number;
};

export type MCPServerHealthStatus = {
  id: string;
  transport: "stdio" | "http";
  connected: boolean;
  target?: string;
  message?: string;
  testedAt: number;
};

export type MCPHealthStatus = {
  connected: number;
  total: number;
  servers: MCPServerHealthStatus[];
};

export type HealthzResponse = {
  name: string;
  version: string;
  startupAt: number;
  queue: QueueStats;
  mcp?: MCPHealthStatus;
};

export type AgentContextResponse = {
  context: AgentContext;
  injectedContext: AgentContext;
  projectionDebug: ContextProjectionDebug;
};

export type AgentMessagesResponse = {
  messages: ModelMessage[];
};

export type MemorySourceTier = "core" | "longterm";
export type MemoryContentState = "active" | "tag_ref";

export type AgentMemoryEntry = {
  id: number;
  block_id: string;
  source_tier: MemorySourceTier;
  type: string;
  summary: string;
  content: string;
  content_state: MemoryContentState;
  tag_id: string | null;
  tag_summary: string | null;
  tags: string[];
  confidence: number;
  decay: number;
  status: string | null;
  first_seen_round: number;
  last_seen_round: number;
  source_task_id: string | null;
  created_at: number;
  updated_at: number;
  last_recalled_at: number | null;
  rehydrated_at: number | null;
  recall_count: number;
  feedback_positive: number;
  feedback_negative: number;
};

export type AgentMemorySearchHit = AgentMemoryEntry & {
  text_score: number;
  confidence_score: number;
  recency_score: number;
  recall_score: number;
  feedback_score: number;
  reuse_probability: number;
  final_score: number;
};

export type AgentMemorySearchRequest = {
  query: string;
  limit?: number;
  mode?: "auto" | "fts" | "like";
  hydrateTagRefs?: boolean;
};

export type AgentMemorySearchResponse = {
  modeUsed: "fts" | "like";
  hits: AgentMemorySearchHit[];
};

export type AgentMemoryGetRequest = {
  entryId?: number;
  blockId?: string;
};

export type AgentMemoryGetResponse = {
  entry: AgentMemoryEntry | null;
};

export type AgentMemoryUpsertItem = {
  blockId: string;
  content: string;
  sourceTier?: MemorySourceTier;
  type?: string;
  tags?: string[];
  confidence?: number;
  decay?: number;
  round?: number;
  sourceTaskId?: string | null;
};

export type AgentMemoryUpsertRequest = {
  items: AgentMemoryUpsertItem[];
};

export type AgentMemoryUpsertResponse = {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

export type AgentMemoryUpdateRequest = {
  entryId: number;
  patch: Partial<{
    content: string;
    summary: string;
    tags: string[];
    confidence: number;
    decay: number;
    status: string | null;
    sourceTier: MemorySourceTier;
    contentState: MemoryContentState;
    tagId: string | null;
    tagSummary: string | null;
    sourceTaskId: string | null;
  }>;
};

export type AgentMemoryUpdateResponse = {
  entry: AgentMemoryEntry | null;
};

export type AgentMemoryDeleteRequest = {
  entryId?: number;
  blockId?: string;
};

export type AgentMemoryDeleteResponse = {
  deleted: boolean;
};

export type AgentMemoryFeedbackRequest = {
  entryId: number;
  direction: "positive" | "negative";
};

export type AgentMemoryFeedbackResponse = {
  ok: boolean;
};

export type AgentMemoryTagResolveRequest = {
  tagId: string;
  hydrateEntries?: boolean;
};

export type AgentMemoryTagResolveResponse = {
  tag_id: string;
  content: string | null;
  hydrated_entries: AgentMemoryEntry[];
};

export type AgentMemoryStatsResponse = {
  total: number;
  active: number;
  tag_ref: number;
  by_tier: Record<MemorySourceTier, number>;
};

export type AgentMemoryCompactResponse = {
  scanned: number;
  tagged: number;
  deleted: number;
  skipped: number;
  mode: "scheduler" | "manual";
  threshold: number;
};

export type AgentMemoryListRecentRequest = {
  limit?: number;
};

export type AgentMemoryListRecentResponse = {
  entries: AgentMemoryEntry[];
};
