import type { AgentSession } from "../session/agent_session";
import type { ContextMemoryBlock, PersistentMemoryConfig, PersistentMemorySearchMode } from "../../../types/agent";

export const PERSISTENT_MEMORY_DB_DIR = ".agent";
export const PERSISTENT_MEMORY_DB_FILENAME = "memory.db";

export type ResolvedPersistentMemoryConfig = {
  enabled: boolean;
  autoRecall: boolean;
  autoCapture: boolean;
  maxRecallItems: number;
  maxRecallLongtermItems: number;
  minCaptureConfidence: number;
  searchMode: PersistentMemorySearchMode;
  tagging: {
    reuseProbabilityThreshold: number;
    placeholderSummaryMaxLen: number;
    reactivatePolicy: {
      enabled: boolean;
      hitCountThreshold: number;
      windowHours: number;
    };
    scheduler: {
      enabled: boolean;
      adaptive: boolean;
      baseIntervalMinutes: number;
      minIntervalMinutes: number;
      maxIntervalMinutes: number;
      jitterRatio: number;
    };
  };
};

export const DEFAULT_PERSISTENT_MEMORY_CONFIG: ResolvedPersistentMemoryConfig = {
  enabled: true,
  autoRecall: true,
  autoCapture: true,
  maxRecallItems: 6,
  maxRecallLongtermItems: 6,
  minCaptureConfidence: 0.7,
  searchMode: "auto",
  tagging: {
    reuseProbabilityThreshold: 0.15,
    placeholderSummaryMaxLen: 120,
    reactivatePolicy: {
      enabled: true,
      hitCountThreshold: 2,
      windowHours: 24,
    },
    scheduler: {
      enabled: true,
      adaptive: true,
      baseIntervalMinutes: 15,
      minIntervalMinutes: 5,
      maxIntervalMinutes: 180,
      jitterRatio: 0.1,
    },
  },
};

export const resolvePersistentMemoryConfig = (
  config?: PersistentMemoryConfig,
): ResolvedPersistentMemoryConfig => {
  const tagging = config?.tagging ?? {};
  const merged: ResolvedPersistentMemoryConfig = {
    ...DEFAULT_PERSISTENT_MEMORY_CONFIG,
    ...(config ?? {}),
    tagging: {
      ...DEFAULT_PERSISTENT_MEMORY_CONFIG.tagging,
      ...tagging,
      reactivatePolicy: {
        ...DEFAULT_PERSISTENT_MEMORY_CONFIG.tagging.reactivatePolicy,
        ...(tagging.reactivatePolicy ?? {}),
      },
      scheduler: {
        ...DEFAULT_PERSISTENT_MEMORY_CONFIG.tagging.scheduler,
        ...(tagging.scheduler ?? {}),
      },
    },
    enabled: config ? config.enabled ?? true : true,
  };

  return {
    ...merged,
    maxRecallItems: Math.max(1, Math.min(12, Math.trunc(merged.maxRecallItems || 6))),
    maxRecallLongtermItems: Math.max(1, Math.min(24, Math.trunc(merged.maxRecallLongtermItems || 6))),
    minCaptureConfidence: Math.max(0, Math.min(1, merged.minCaptureConfidence ?? 0.7)),
    tagging: {
      ...merged.tagging,
      reuseProbabilityThreshold: Math.max(0, Math.min(1, merged.tagging.reuseProbabilityThreshold ?? 0.15)),
      placeholderSummaryMaxLen: Math.max(24, Math.min(240, Math.trunc(merged.tagging.placeholderSummaryMaxLen || 120))),
      reactivatePolicy: {
        ...merged.tagging.reactivatePolicy,
        hitCountThreshold: Math.max(1, Math.min(12, Math.trunc(merged.tagging.reactivatePolicy.hitCountThreshold || 2))),
        windowHours: Math.max(1, Math.min(168, Math.trunc(merged.tagging.reactivatePolicy.windowHours || 24))),
      },
      scheduler: {
        ...merged.tagging.scheduler,
        baseIntervalMinutes: Math.max(1, Math.min(720, Math.trunc(merged.tagging.scheduler.baseIntervalMinutes || 15))),
        minIntervalMinutes: Math.max(1, Math.min(720, Math.trunc(merged.tagging.scheduler.minIntervalMinutes || 5))),
        maxIntervalMinutes: Math.max(1, Math.min(720, Math.trunc(merged.tagging.scheduler.maxIntervalMinutes || 180))),
        jitterRatio: Math.max(0, Math.min(0.5, merged.tagging.scheduler.jitterRatio ?? 0.1)),
      },
    },
  };
};

export type PersistentMemoryDatabaseRuntime = {
  dbPath: string;
  ftsEnabled: boolean;
};

export type PersistentMemoryEntryRow = {
  id: number;
  block_id: string;
  source_tier: "core" | "longterm";
  memory_type: string;
  summary: string;
  content: string;
  content_state: "active" | "tag_ref";
  tag_id: string | null;
  tag_summary: string | null;
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
  rehydrated_at: number | null;
  recall_count: number;
  feedback_positive: number;
  feedback_negative: number;
};

export type PersistentMemoryEntry = {
  id: number;
  blockId: string;
  sourceTier: "core" | "longterm";
  memoryType: string;
  summary: string;
  content: string;
  contentState: "active" | "tag_ref";
  tagId: string | null;
  tagSummary: string | null;
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
  rehydratedAt: number | null;
  recallCount: number;
  feedbackPositive: number;
  feedbackNegative: number;
};

export type PersistentMemoryTagPayloadRow = {
  tag_id: string;
  full_content: string;
  created_at: number;
  updated_at: number;
};

export type PersistentMemorySearchHit = {
  entry: PersistentMemoryEntry;
  textScore: number;
  confidenceScore: number;
  recencyScore: number;
  recallScore: number;
  feedbackScore: number;
  reuseProbability: number;
  finalScore: number;
};

export type PersistentMemorySearchResult = {
  hits: PersistentMemorySearchHit[];
  modeUsed: "fts" | "like";
};

export type PersistentMemoryBulkReadResult = {
  entries: PersistentMemoryEntry[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
  modeUsed: "fts" | "like";
};

export type UpsertCoreBlocksArgs = {
  blocks: ContextMemoryBlock[];
  sourceTier?: "core" | "longterm";
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
