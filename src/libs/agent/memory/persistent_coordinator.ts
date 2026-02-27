import type {
  AgentContext,
  ContextMemoryBlock,
  PersistentMemoryConfig,
  PersistentMemorySearchMode,
} from "../../../types/agent";
import type { AgentSession } from "../session/agent_session";
import {
  closePersistentMemoryDatabase,
  getPersistentMemoryDbPath,
  openPersistentMemoryDatabase,
  type PersistentMemoryDatabaseHandle,
} from "./persistent_db";
import { derivePersistentMemorySummary, PersistentMemoryStore } from "./persistent_store";
import {
  resolvePersistentMemoryConfig,
  type PersistentMemoryAfterTaskMeta,
  type PersistentMemoryCoordinatorStatus,
  type PersistentMemoryHooks,
  type ResolvedPersistentMemoryConfig,
} from "./persistent_types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const uniqueTags = (tags: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 24) {
      break;
    }
  }
  return result;
};

const normalizeQuery = (query: string) => query.trim();

type LoggerLike = Pick<Console, "log" | "warn">;

type CompactionSummary = {
  scanned: number;
  tagged: number;
  deleted: number;
  skipped: number;
  mode: "scheduler" | "manual";
};

type MemoryUpsertInput = {
  blockId: string;
  content: string;
  type?: string;
  tags?: string[];
  confidence?: number;
  decay?: number;
  round?: number;
  sourceTier?: "core" | "longterm";
  sourceTaskId?: string | null;
};

const isWorkingBlockStatus = (value: unknown): value is "open" | "done" | "failed" | "cancelled" =>
  value === "open" || value === "done" || value === "failed" || value === "cancelled";

const toEntrySummary = (entry: {
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
}) => ({
  id: entry.id,
  block_id: entry.blockId,
  source_tier: entry.sourceTier,
  type: entry.memoryType,
  summary: entry.summary,
  content: entry.content,
  content_state: entry.contentState,
  tag_id: entry.tagId,
  tag_summary: entry.tagSummary,
  tags: entry.tags,
  confidence: entry.confidence,
  decay: entry.decay,
  status: entry.status,
  first_seen_round: entry.firstSeenRound,
  last_seen_round: entry.lastSeenRound,
  source_task_id: entry.sourceTaskId,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
  last_recalled_at: entry.lastRecalledAt,
  rehydrated_at: entry.rehydratedAt,
  recall_count: entry.recallCount,
  feedback_positive: entry.feedbackPositive,
  feedback_negative: entry.feedbackNegative,
});

export class PersistentMemoryCoordinator {
  private readonly config: ResolvedPersistentMemoryConfig;
  private readonly logger: LoggerLike;
  private readonly store?: PersistentMemoryStore;
  private readonly dbHandle?: PersistentMemoryDatabaseHandle;
  private readonly statusValue: PersistentMemoryCoordinatorStatus;
  private compactionTimer: ReturnType<typeof setTimeout> | null = null;
  private compactionRunning = false;
  private disposed = false;
  private readonly taskActivityTimestamps: number[] = [];

  private constructor(args: {
    config: ResolvedPersistentMemoryConfig;
    logger: LoggerLike;
    store?: PersistentMemoryStore;
    dbHandle?: PersistentMemoryDatabaseHandle;
    status: PersistentMemoryCoordinatorStatus;
  }) {
    this.config = args.config;
    this.logger = args.logger;
    this.store = args.store;
    this.dbHandle = args.dbHandle;
    this.statusValue = args.status;

    if (this.store && this.statusValue.available) {
      this.scheduleCompaction();
    }
  }

  static initialize(args: {
    workspace: string;
    config?: PersistentMemoryConfig;
    logger?: LoggerLike;
  }): PersistentMemoryCoordinator {
    const logger = args.logger ?? console;
    const resolved = resolvePersistentMemoryConfig(args.config);

    if (!resolved.enabled) {
      return new PersistentMemoryCoordinator({
        config: resolved,
        logger,
        status: {
          enabled: false,
          available: false,
          dbPath: "",
          message: "disabled",
        },
      });
    }

    try {
      const handle = openPersistentMemoryDatabase(args.workspace);
      const store = new PersistentMemoryStore(handle);
      return new PersistentMemoryCoordinator({
        config: resolved,
        logger,
        store,
        dbHandle: handle,
        status: {
          enabled: true,
          available: true,
          dbPath: store.dbPath,
          searchModeUsed: handle.runtime.ftsEnabled && resolved.searchMode !== "like" ? "fts" : "like",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[memory] persistent init failed: ${message}`);
      return new PersistentMemoryCoordinator({
        config: resolved,
        logger,
        status: {
          enabled: true,
          available: false,
          dbPath: getPersistentMemoryDbPath(args.workspace),
          message,
        },
      });
    }
  }

  get status(): PersistentMemoryCoordinatorStatus {
    return { ...this.statusValue };
  }

  get hooks(): PersistentMemoryHooks {
    return {
      beforeTask: async (session, question) => {
        await this.beforeTask(session, question);
      },
      afterTask: async (session, meta) => {
        await this.afterTask(session, meta);
      },
      dispose: async () => {
        await this.dispose();
      },
    };
  }

  private getOperationalStore(): PersistentMemoryStore | null {
    if (!this.store || !this.statusValue.available || this.disposed) {
      return null;
    }
    return this.store;
  }

  private noteTaskActivity(now = Date.now()) {
    this.taskActivityTimestamps.push(now);
    const cutoff = now - 6 * HOUR_MS;
    while (this.taskActivityTimestamps.length > 0 && this.taskActivityTimestamps[0]! < cutoff) {
      this.taskActivityTimestamps.shift();
    }
  }

  private computeAdaptiveCompactionIntervalMs() {
    const scheduler = this.config.tagging.scheduler;
    const min = Math.max(1, scheduler.minIntervalMinutes);
    const max = Math.max(min, scheduler.maxIntervalMinutes);
    const base = Math.max(min, Math.min(max, scheduler.baseIntervalMinutes));
    const rawMinutes = scheduler.adaptive
      ? this.scaleIntervalByRecentDensity({ min, max, fallback: base })
      : base;
    const jitter = clamp01(scheduler.jitterRatio);
    const delta = rawMinutes * jitter;
    const jitteredMinutes = rawMinutes + (Math.random() * 2 - 1) * delta;
    return Math.max(60_000, Math.round(jitteredMinutes * 60_000));
  }

  private scaleIntervalByRecentDensity(args: {
    min: number;
    max: number;
    fallback: number;
  }) {
    const now = Date.now();
    const recent = this.taskActivityTimestamps.filter((ts) => now - ts <= HOUR_MS).length;
    if (recent <= 1) {
      return args.max;
    }
    if (recent >= 24) {
      return args.min;
    }
    const ratio = (recent - 1) / (24 - 1);
    const scaled = args.max - ratio * (args.max - args.min);
    if (!Number.isFinite(scaled)) {
      return args.fallback;
    }
    return Math.max(args.min, Math.min(args.max, scaled));
  }

  private clearCompactionTimer() {
    if (!this.compactionTimer) {
      return;
    }
    clearTimeout(this.compactionTimer);
    this.compactionTimer = null;
  }

  private scheduleCompaction() {
    this.clearCompactionTimer();
    const store = this.getOperationalStore();
    if (!store) return;
    if (!this.config.tagging.scheduler.enabled) return;

    const delayMs = this.computeAdaptiveCompactionIntervalMs();
    this.compactionTimer = setTimeout(async () => {
      this.compactionTimer = null;
      try {
        await this.runCompactionCycle("scheduler");
      } catch (error) {
        this.logger.warn(
          `[memory] compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (!this.disposed) {
          this.scheduleCompaction();
        }
      }
    }, delayMs);

    const timeout = this.compactionTimer as unknown as { unref?: () => void };
    timeout.unref?.();
  }

  private computeReuseProbability(entry: {
    recallCount: number;
    updatedAt: number;
    confidence: number;
  }) {
    const hitScore = clamp01(entry.recallCount / 20);
    const ageDays = Math.max(0, Date.now() - entry.updatedAt) / DAY_MS;
    const recencyScore = clamp01(1 / (1 + ageDays / 30));
    const semanticScore = clamp01(entry.confidence);
    return clamp01(0.5 * hitScore + 0.3 * recencyScore + 0.2 * semanticScore);
  }

  private isLowImportance(entry: {
    decay: number;
    confidence: number;
    recallCount: number;
    updatedAt: number;
  }) {
    if (entry.decay >= 0.62) {
      return true;
    }
    if (entry.confidence <= 0.52) {
      return true;
    }
    const staleDays = Math.max(0, Date.now() - entry.updatedAt) / DAY_MS;
    return staleDays >= 21 && entry.recallCount <= 1;
  }

  private buildTagId(blockId: string) {
    const safe = blockId.replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 64);
    const nonce = Math.random().toString(36).slice(2, 8);
    return `tag:${safe}:${Date.now().toString(36)}:${nonce}`;
  }

  private buildTagSummary(content: string) {
    const summary = derivePersistentMemorySummary(content);
    const maxLen = this.config.tagging.placeholderSummaryMaxLen;
    return summary.length > maxLen ? summary.slice(0, maxLen) : summary;
  }

  private buildTagPlaceholder(args: { tagId: string; summary: string }) {
    const placeholder = `[tag_ref:${args.tagId}] ${args.summary}`.trim();
    return placeholder.length > this.config.tagging.placeholderSummaryMaxLen
      ? placeholder.slice(0, this.config.tagging.placeholderSummaryMaxLen)
      : placeholder;
  }

  private async runCompactionCycle(mode: "scheduler" | "manual"): Promise<CompactionSummary> {
    const store = this.getOperationalStore();
    if (!store) {
      return {
        scanned: 0,
        tagged: 0,
        deleted: 0,
        skipped: 0,
        mode,
      };
    }

    if (this.compactionRunning) {
      return {
        scanned: 0,
        tagged: 0,
        deleted: 0,
        skipped: 1,
        mode,
      };
    }

    this.compactionRunning = true;
    try {
      const entries = await store.listAllEntries();
      let scanned = 0;
      let tagged = 0;
      let deleted = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (entry.contentState !== "active") {
          continue;
        }

        scanned += 1;
        if (!this.isLowImportance(entry)) {
          continue;
        }

        const reuseProbability = this.computeReuseProbability(entry);
        if (reuseProbability > this.config.tagging.reuseProbabilityThreshold) {
          const tagId = this.buildTagId(entry.blockId);
          const tagSummary = this.buildTagSummary(entry.content);
          const placeholderContent = this.buildTagPlaceholder({
            tagId,
            summary: tagSummary,
          });

          await store.saveTagPayload({
            tagId,
            fullContent: entry.content,
          });
          await store.tagEntryReference({
            entryId: entry.id,
            tagId,
            tagSummary,
            placeholderContent,
          });
          await store.appendEvent({
            entryId: entry.id,
            blockId: entry.blockId,
            eventType: "entry_tagged",
            payload: {
              reuse_probability: reuseProbability,
              threshold: this.config.tagging.reuseProbabilityThreshold,
            },
          });
          tagged += 1;
          continue;
        }

        await store.appendEvent({
          entryId: entry.id,
          blockId: entry.blockId,
          eventType: "entry_archived",
          payload: {
            reuse_probability: reuseProbability,
            threshold: this.config.tagging.reuseProbabilityThreshold,
          },
        });
        if (await store.deleteEntryById(entry.id)) {
          deleted += 1;
        } else {
          skipped += 1;
        }
      }

      return { scanned, tagged, deleted, skipped, mode };
    } finally {
      this.compactionRunning = false;
    }
  }

  private toRecallBlock(args: {
    entry: {
      blockId: string;
      memoryType: string;
      decay: number;
      confidence: number;
      tags: string[];
      content: string;
      tagId: string | null;
      tagSummary: string | null;
      contentState: "active" | "tag_ref";
      rehydratedAt: number | null;
    };
    round: number;
    finalScore: number;
    tier: "ephemeral" | "longterm";
  }): ContextMemoryBlock {
    const type = args.tier === "longterm" ? "persistent_longterm_recall" : "persistent_recall";
    return {
      id: `persistent:${args.entry.blockId}`,
      type,
      decay: Math.min(args.entry.decay, args.tier === "longterm" ? 0.3 : 0.25),
      confidence: clamp01(Math.max(args.entry.confidence, 0.7)),
      round: args.round,
      tags: uniqueTags([
        ...args.entry.tags,
        "persistent",
        "recall",
        args.tier,
      ]),
      content: args.entry.content,
      content_state: args.entry.contentState,
      ...(args.entry.tagId ? { tag_id: args.entry.tagId } : {}),
      ...(args.entry.tagSummary ? { tag_summary: args.entry.tagSummary } : {}),
      ...(typeof args.entry.rehydratedAt === "number" ? { rehydrated_at: args.entry.rehydratedAt } : {}),
      persistent_block_id: args.entry.blockId,
      persistent_score: Number(args.finalScore.toFixed(6)),
    };
  }

  private async beforeTask(session: AgentSession, question: string): Promise<void> {
    const store = this.getOperationalStore();
    if (!store) return;

    this.noteTaskActivity();
    if (!this.config.autoRecall) return;
    const query = normalizeQuery(question);
    if (!query) return;

    const snapshot = session.getContextSnapshot();
    const excludeBlockIds = new Set([
      ...snapshot.memory.core.map((block) => block.id),
      ...snapshot.memory.longterm.map((block) => block.id),
    ]);

    const search = await store.searchRelevant({
      query,
      limit: Math.min(24, this.config.maxRecallItems + this.config.maxRecallLongtermItems + 8),
      mode: this.config.searchMode,
      excludeBlockIds,
    });
    const fallbackLimit = Math.max(2, Math.min(12, this.config.maxRecallItems + this.config.maxRecallLongtermItems));
    const fallbackEntries = search.hits.length === 0
      ? (await store.listRecent(fallbackLimit))
        .filter((entry) => !excludeBlockIds.has(entry.blockId))
        .filter((entry) => Date.now() - entry.updatedAt <= 14 * DAY_MS)
      : [];
    if (search.hits.length === 0 && fallbackEntries.length === 0) {
      return;
    }

    let coreCount = 0;
    let longtermCount = 0;
    const selected = [];
    for (const hit of search.hits) {
      if (hit.entry.sourceTier === "longterm") {
        if (longtermCount >= this.config.maxRecallLongtermItems) continue;
        longtermCount += 1;
      } else {
        if (coreCount >= this.config.maxRecallItems) continue;
        coreCount += 1;
      }
      selected.push(hit);
      if (
        coreCount >= this.config.maxRecallItems &&
        longtermCount >= this.config.maxRecallLongtermItems
      ) {
        break;
      }
    }

    if (selected.length === 0) {
      for (const entry of fallbackEntries) {
        if (entry.sourceTier === "longterm") {
          if (longtermCount >= this.config.maxRecallLongtermItems) continue;
          longtermCount += 1;
        } else {
          if (coreCount >= this.config.maxRecallItems) continue;
          coreCount += 1;
        }
        selected.push({
          entry,
          textScore: 0.3,
          confidenceScore: entry.confidence,
          recencyScore: 0.8,
          recallScore: clamp01(entry.recallCount / 20),
          feedbackScore: 0.5,
          reuseProbability: this.computeReuseProbability(entry),
          finalScore: 0.45,
        });
        if (
          coreCount >= this.config.maxRecallItems &&
          longtermCount >= this.config.maxRecallLongtermItems
        ) {
          break;
        }
      }
    }

    if (selected.length === 0) {
      return;
    }

    const currentRound = snapshot.runtime.round;
    const ephemeralBlocks: ContextMemoryBlock[] = [];
    const longtermBlocks: ContextMemoryBlock[] = [];
    const recalledIds: number[] = [];

    for (const hit of selected) {
      let entry = hit.entry;
      if (entry.contentState === "tag_ref" && entry.tagId) {
        entry = await store.hydrateTagRef(entry);
      }

      const tier = entry.sourceTier === "longterm" ? "longterm" : "ephemeral";
      const block = this.toRecallBlock({
        entry,
        round: currentRound,
        finalScore: hit.finalScore,
        tier,
      });
      if (tier === "longterm") {
        longtermBlocks.push(block);
      } else {
        ephemeralBlocks.push(block);
      }
      recalledIds.push(entry.id);
    }

    const memoryPatch: Partial<AgentContext["memory"]> = {};
    if (ephemeralBlocks.length > 0) {
      memoryPatch.ephemeral = ephemeralBlocks;
    }
    if (longtermBlocks.length > 0) {
      memoryPatch.longterm = longtermBlocks;
    }
    if (Object.keys(memoryPatch).length > 0) {
      session.mergeSystemContextPatch({
        memory: memoryPatch,
      } as Partial<AgentContext>);
    }

    await store.markRecalled(recalledIds);
  }

  private async afterTask(
    session: AgentSession,
    _meta?: PersistentMemoryAfterTaskMeta,
  ): Promise<void> {
    const store = this.getOperationalStore();
    if (!store) return;
    this.noteTaskActivity();
    if (!this.config.autoCapture) return;

    const snapshot = session.getContextSnapshot();
    const shouldCapture = (block: ContextMemoryBlock) => {
      if (typeof block.id !== "string" || block.id.trim() === "") return false;
      if (typeof block.content !== "string" || block.content.trim() === "") return false;
      return typeof block.confidence === "number" && block.confidence >= this.config.minCaptureConfidence;
    };

    const coreBlocks = snapshot.memory.core.filter(shouldCapture);
    const longtermBlocks = snapshot.memory.longterm.filter(shouldCapture);
    const workingToLongterm = snapshot.memory.working
      .filter((block) => {
        if (!shouldCapture(block)) return false;
        if (typeof block.decay === "number" && block.decay > 0.58) return false;
        if (typeof block.content !== "string" || block.content.trim().length < 16) return false;
        if (isWorkingBlockStatus(block.status) && block.status === "failed") return false;
        return true;
      })
      .map((block) => ({
        ...block,
        id: `working:${block.id}`,
        type: block.type || "working_memory",
        tags: uniqueTags([...(Array.isArray(block.tags) ? block.tags : []), "working_capture"]),
        decay: typeof block.decay === "number" ? Math.min(block.decay + 0.1, 0.65) : 0.45,
        confidence: typeof block.confidence === "number"
          ? clamp01(Math.max(block.confidence, this.config.minCaptureConfidence))
          : this.config.minCaptureConfidence,
      }));
    if (coreBlocks.length === 0 && longtermBlocks.length === 0) {
      if (workingToLongterm.length === 0) {
        return;
      }
    }

    const activeTaskMeta = (snapshot as Record<string, unknown>).active_task_meta;
    const sourceTaskId =
      activeTaskMeta && typeof activeTaskMeta === "object" && !Array.isArray(activeTaskMeta)
        ? (typeof (activeTaskMeta as Record<string, unknown>).id === "string"
            ? (activeTaskMeta as Record<string, unknown>).id as string
            : null)
        : null;

    if (coreBlocks.length > 0) {
      await store.upsertCoreBlocks({
        blocks: coreBlocks,
        sourceTier: "core",
        sourceTaskId,
      });
    }
    if (longtermBlocks.length > 0) {
      await store.upsertCoreBlocks({
        blocks: longtermBlocks,
        sourceTier: "longterm",
        sourceTaskId,
      });
    }
    if (workingToLongterm.length > 0) {
      await store.upsertCoreBlocks({
        blocks: workingToLongterm,
        sourceTier: "longterm",
        sourceTaskId,
      });
    }
  }

  async search(args: {
    query: string;
    limit?: number;
    mode?: PersistentMemorySearchMode;
    hydrateTagRefs?: boolean;
  }) {
    const store = this.getOperationalStore();
    if (!store) {
      return { modeUsed: "like" as const, hits: [] as Array<Record<string, unknown>> };
    }

    const query = normalizeQuery(args.query);
    if (!query) {
      return { modeUsed: "like" as const, hits: [] as Array<Record<string, unknown>> };
    }

    const result = await store.searchRelevant({
      query,
      limit: Math.max(1, Math.min(50, Math.trunc(args.limit ?? 10))),
      mode: args.mode ?? this.config.searchMode,
    });

    const hits: Array<Record<string, unknown>> = [];
    for (const hit of result.hits) {
      const entry = args.hydrateTagRefs && hit.entry.contentState === "tag_ref" && hit.entry.tagId
        ? await store.hydrateTagRef(hit.entry)
        : hit.entry;
      hits.push({
        ...toEntrySummary(entry),
        text_score: hit.textScore,
        confidence_score: hit.confidenceScore,
        recency_score: hit.recencyScore,
        recall_score: hit.recallScore,
        feedback_score: hit.feedbackScore,
        reuse_probability: hit.reuseProbability,
        final_score: hit.finalScore,
      });
    }

    return {
      modeUsed: result.modeUsed,
      hits,
    };
  }

  async get(args: { entryId?: number; blockId?: string }) {
    const store = this.getOperationalStore();
    if (!store) return null;
    if (typeof args.entryId === "number" && Number.isFinite(args.entryId)) {
      const entry = await store.getEntryById(args.entryId);
      return entry ? toEntrySummary(entry) : null;
    }
    if (typeof args.blockId === "string" && args.blockId.trim()) {
      const entry = await store.getEntryByBlockId(args.blockId.trim());
      return entry ? toEntrySummary(entry) : null;
    }
    return null;
  }

  async upsert(args: {
    items: MemoryUpsertInput[];
  }) {
    const store = this.getOperationalStore();
    if (!store) return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };

    const blocks: ContextMemoryBlock[] = args.items.map((item, index) => ({
      id: item.blockId.trim(),
      type: item.type?.trim() || "memory_note",
      decay: clamp01(item.decay ?? 0.2),
      confidence: clamp01(item.confidence ?? 0.85),
      round: Math.max(1, Math.trunc(item.round ?? (index + 1))),
      tags: uniqueTags(item.tags ?? []),
      content: item.content.trim(),
    }));

    const grouped = {
      core: [] as ContextMemoryBlock[],
      longterm: [] as ContextMemoryBlock[],
    };
    args.items.forEach((item, index) => {
      const tier = item.sourceTier ?? "core";
      if (tier === "longterm") {
        grouped.longterm.push(blocks[index]!);
      } else {
        grouped.core.push(blocks[index]!);
      }
    });

    const total = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    };
    if (grouped.core.length > 0) {
      const result = await store.upsertCoreBlocks({
        blocks: grouped.core,
        sourceTier: "core",
      });
      total.inserted += result.inserted;
      total.updated += result.updated;
      total.unchanged += result.unchanged;
      total.skipped += result.skipped;
    }
    if (grouped.longterm.length > 0) {
      const result = await store.upsertCoreBlocks({
        blocks: grouped.longterm,
        sourceTier: "longterm",
      });
      total.inserted += result.inserted;
      total.updated += result.updated;
      total.unchanged += result.unchanged;
      total.skipped += result.skipped;
    }
    return total;
  }

  async update(args: {
    entryId: number;
    patch: Partial<{
      content: string;
      summary: string;
      tags: string[];
      confidence: number;
      decay: number;
      status: string | null;
      sourceTier: "core" | "longterm";
      contentState: "active" | "tag_ref";
      tagId: string | null;
      tagSummary: string | null;
      sourceTaskId: string | null;
    }>;
  }) {
    const store = this.getOperationalStore();
    if (!store) return null;
    const entry = await store.updateEntry(args);
    return entry ? toEntrySummary(entry) : null;
  }

  async delete(args: { entryId?: number; blockId?: string }) {
    const store = this.getOperationalStore();
    if (!store) return { deleted: false };
    if (typeof args.entryId === "number" && Number.isFinite(args.entryId)) {
      return { deleted: await store.deleteEntryById(args.entryId) };
    }
    if (typeof args.blockId === "string" && args.blockId.trim()) {
      return { deleted: await store.deleteEntryByBlockId(args.blockId.trim()) };
    }
    return { deleted: false };
  }

  async feedback(args: { entryId: number; direction: "positive" | "negative" }) {
    const store = this.getOperationalStore();
    if (!store) return { ok: false };
    await store.applyFeedback(args.entryId, args.direction);
    return { ok: true };
  }

  async resolveTag(args: { tagId: string; hydrateEntries?: boolean }) {
    const store = this.getOperationalStore();
    if (!store) return { tag_id: args.tagId, content: null, hydrated_entries: [] as unknown[] };
    const content = await store.resolveTag(args.tagId);
    if (!args.hydrateEntries || !content) {
      return {
        tag_id: args.tagId,
        content,
        hydrated_entries: [],
      };
    }

    const hydratedEntries = await store.hydrateEntriesByTagId(args.tagId);
    return {
      tag_id: args.tagId,
      content,
      hydrated_entries: hydratedEntries.map((entry) => toEntrySummary(entry)),
    };
  }

  async getStats() {
    const store = this.getOperationalStore();
    if (!store) {
      return {
        total: 0,
        active: 0,
        tag_ref: 0,
        by_tier: {
          core: 0,
          longterm: 0,
        },
      };
    }
    const stats = await store.getStats();
    return {
      total: stats.total,
      active: stats.active,
      tag_ref: stats.tagRef,
      by_tier: stats.byTier,
    };
  }

  async compactNow() {
    const result = await this.runCompactionCycle("manual");
    return {
      ...result,
      threshold: this.config.tagging.reuseProbabilityThreshold,
    };
  }

  async listRecent(limit = 20) {
    const store = this.getOperationalStore();
    if (!store) return [];
    const entries = await store.listRecent(limit);
    return entries.map((entry) => toEntrySummary(entry));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearCompactionTimer();
    await closePersistentMemoryDatabase(this.dbHandle);
  }
}
