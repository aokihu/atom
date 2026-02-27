import type {
  AgentContext,
  ContextMemoryBlock,
  PersistentMemoryConfig,
} from "../../../types/agent";
import type { AgentSession } from "../session/agent_session";
import {
  closePersistentMemoryDatabase,
  getPersistentMemoryDbPath,
  openPersistentMemoryDatabase,
  type PersistentMemoryDatabaseHandle,
} from "./persistent_db";
import { PersistentMemoryStore } from "./persistent_store";
import {
  resolvePersistentMemoryConfig,
  type PersistentMemoryAfterTaskMeta,
  type PersistentMemoryCoordinatorStatus,
  type PersistentMemoryHooks,
  type ResolvedPersistentMemoryConfig,
} from "./persistent_types";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const uniqueTags = (tags: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

type LoggerLike = Pick<Console, "log" | "warn">;

export class PersistentMemoryCoordinator {
  private readonly config: ResolvedPersistentMemoryConfig;
  private readonly store?: PersistentMemoryStore;
  private readonly dbHandle?: PersistentMemoryDatabaseHandle;
  private readonly statusValue: PersistentMemoryCoordinatorStatus;

  private constructor(args: {
    config: ResolvedPersistentMemoryConfig;
    logger: LoggerLike;
    store?: PersistentMemoryStore;
    dbHandle?: PersistentMemoryDatabaseHandle;
    status: PersistentMemoryCoordinatorStatus;
  }) {
    this.config = args.config;
    this.store = args.store;
    this.dbHandle = args.dbHandle;
    this.statusValue = args.status;
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

  async dispose(): Promise<void> {
    await closePersistentMemoryDatabase(this.dbHandle);
  }

  private getOperationalStore(): PersistentMemoryStore | null {
    if (!this.store || !this.statusValue.available) {
      return null;
    }
    return this.store;
  }

  private async beforeTask(session: AgentSession, question: string): Promise<void> {
    const store = this.getOperationalStore();
    if (!store) return;
    if (!this.config.autoRecall) return;
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return;

    const snapshot = session.getContextSnapshot();
    const coreBlockIds = new Set(snapshot.memory.core.map((block) => block.id));

    const search = await store.searchRelevant({
      query: normalizedQuestion,
      limit: this.config.maxRecallItems,
      mode: this.config.searchMode,
      excludeBlockIds: coreBlockIds,
    });

    if (search.hits.length === 0) {
      return;
    }

    const currentRound = snapshot.runtime.round;
    const recallBlocks: ContextMemoryBlock[] = search.hits.map((hit) => ({
      id: `persistent:${hit.entry.blockId}`,
      type: "persistent_recall",
      decay: Math.min(hit.entry.decay, 0.25),
      confidence: clamp01(Math.max(hit.entry.confidence, 0.7)),
      round: currentRound,
      tags: uniqueTags([...hit.entry.tags, "persistent", "recall"]),
      content: hit.entry.content,
      persistent_block_id: hit.entry.blockId,
      persistent_score: Number(hit.finalScore.toFixed(6)),
    }));

    session.mergeSystemContextPatch({
      memory: {
        ephemeral: recallBlocks,
      },
    } as Partial<AgentContext>);

    await store.markRecalled(search.hits.map((hit) => hit.entry.id));
  }

  private async afterTask(
    session: AgentSession,
    _meta?: PersistentMemoryAfterTaskMeta,
  ): Promise<void> {
    const store = this.getOperationalStore();
    if (!store) return;
    if (!this.config.autoCapture) return;

    const snapshot = session.getContextSnapshot();
    const coreBlocks = snapshot.memory.core.filter((block) => {
      if (typeof block.id !== "string" || block.id.trim() === "") return false;
      if (typeof block.content !== "string" || block.content.trim() === "") return false;
      return typeof block.confidence === "number" && block.confidence >= this.config.minCaptureConfidence;
    });

    if (coreBlocks.length === 0) {
      return;
    }

    const activeTaskMeta = (snapshot as Record<string, unknown>).active_task_meta;
    const sourceTaskId =
      activeTaskMeta && typeof activeTaskMeta === "object" && !Array.isArray(activeTaskMeta)
        ? (typeof (activeTaskMeta as Record<string, unknown>).id === "string"
            ? (activeTaskMeta as Record<string, unknown>).id as string
            : null)
        : null;

    await store.upsertCoreBlocks({
      blocks: coreBlocks,
      sourceTaskId,
    });
  }
}
