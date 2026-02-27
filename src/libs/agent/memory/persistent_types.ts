import type { AgentSession } from "../session/agent_session";
import type { ContextMemoryBlock, PersistentMemoryConfig, PersistentMemorySearchMode } from "../../../types/agent";

export const PERSISTENT_MEMORY_DB_DIR = ".agent";
export const PERSISTENT_MEMORY_DB_FILENAME = "memory.db";

export type ResolvedPersistentMemoryConfig = {
  enabled: boolean;
  autoRecall: boolean;
  autoCapture: boolean;
  maxRecallItems: number;
  minCaptureConfidence: number;
  searchMode: PersistentMemorySearchMode;
};

export const DEFAULT_PERSISTENT_MEMORY_CONFIG: ResolvedPersistentMemoryConfig = {
  enabled: false,
  autoRecall: true,
  autoCapture: true,
  maxRecallItems: 6,
  minCaptureConfidence: 0.7,
  searchMode: "auto",
};

export const resolvePersistentMemoryConfig = (
  config?: PersistentMemoryConfig,
): ResolvedPersistentMemoryConfig => {
  const merged: ResolvedPersistentMemoryConfig = {
    ...DEFAULT_PERSISTENT_MEMORY_CONFIG,
    ...(config ?? {}),
    enabled: config ? config.enabled ?? true : false,
  };

  return {
    ...merged,
    maxRecallItems: Math.max(1, Math.min(12, Math.trunc(merged.maxRecallItems || 6))),
    minCaptureConfidence: Math.max(0, Math.min(1, merged.minCaptureConfidence ?? 0.7)),
  };
};

export type PersistentMemoryDatabaseRuntime = {
  dbPath: string;
  ftsEnabled: boolean;
};

export type PersistentMemoryEntryRow = {
  id: number;
  block_id: string;
  source_tier: "core";
  memory_type: string;
  summary: string;
  content: string;
  tags_json: string;
  confidence: number;
  decay: number;
  status: string | null;
  content_hash: string;
  first_seen_round: number;
  last_seen_round: number;
  source_task_id: string | null;
  created_at: number;
  updated_at: number;
  last_recalled_at: number | null;
  recall_count: number;
};

export type PersistentMemoryEntry = {
  id: number;
  blockId: string;
  sourceTier: "core";
  memoryType: string;
  summary: string;
  content: string;
  tags: string[];
  confidence: number;
  decay: number;
  status: string | null;
  contentHash: string;
  firstSeenRound: number;
  lastSeenRound: number;
  sourceTaskId: string | null;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt: number | null;
  recallCount: number;
};

export type PersistentMemorySearchHit = {
  entry: PersistentMemoryEntry;
  textScore: number;
  confidenceScore: number;
  recencyScore: number;
  recallScore: number;
  finalScore: number;
};

export type PersistentMemorySearchResult = {
  hits: PersistentMemorySearchHit[];
  modeUsed: "fts" | "like";
};

export type UpsertCoreBlocksArgs = {
  blocks: ContextMemoryBlock[];
  sourceTaskId?: string | null;
};

export type PersistentMemoryUpsertStats = {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

export type PersistentMemoryAfterTaskMeta = {
  completed?: boolean;
  finishReason?: string;
  stopReason?: string;
  mode?: "detailed" | "stream";
};

export type PersistentMemoryHooks = {
  beforeTask: (session: AgentSession, question: string) => Promise<void>;
  afterTask: (session: AgentSession, meta?: PersistentMemoryAfterTaskMeta) => Promise<void>;
  dispose?: () => Promise<void>;
};

export type PersistentMemoryCoordinatorStatus = {
  enabled: boolean;
  available: boolean;
  dbPath: string;
  message?: string;
  searchModeUsed?: "fts" | "like";
};
