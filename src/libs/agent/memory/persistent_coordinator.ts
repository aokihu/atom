import type { AgentSession } from "../session/agent_session";
import type { AgentContext, ContextMemoryBlock, MemoryConfig } from "../../../types/agent";
import { PersistentCaptureQueue } from "./persistent_queue";
import {
  canonicalizePersistentBlockId,
  hashPersistentContent,
  PersistentMemoryStore,
} from "./persistent_store";
import {
  resolvePersistentMemoryConfig,
  toPersistentEntryPayload,
  type PersistentCaptureJob,
  type ResolvedPersistentMemoryConfig,
} from "./persistent_types";

const isRecallLikeBlock = (block: ContextMemoryBlock): boolean => {
  if (typeof block.type === "string" && /^persistent_(?:longterm_)?recall$/i.test(block.type)) {
    return true;
  }
  if (typeof block.id === "string" && block.id.startsWith("persistent:")) {
    return true;
  }
  if (typeof (block as Record<string, unknown>).persistent_block_id === "string") {
    return true;
  }
  return false;
};

const withTimeout = async <T>(fn: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  const safeTimeout = Math.max(1, Math.floor(timeoutMs));
  return await Promise.race([
    fn(),
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), safeTimeout);
    }),
  ]);
};

const extractTaskId = (context: AgentContext): string => {
  const meta = context.active_task_meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return "unknown";
  }
  const id = (meta as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() !== "" ? id : "unknown";
};

const listCaptureCandidates = (context: AgentContext): ContextMemoryBlock[] => {
  const tiers: Array<keyof AgentContext["memory"]> = ["core", "working", "longterm"];
  const blocks: ContextMemoryBlock[] = [];

  for (const tier of tiers) {
    const list = context.memory[tier];
    if (!Array.isArray(list)) continue;
    for (const block of list) {
      if (isRecallLikeBlock(block)) continue;
      blocks.push(block);
    }
  }

  return blocks;
};

const toRecallBlock = (entry: {
  blockId: string;
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  decay: number;
  round: number;
}): ContextMemoryBlock => ({
  id: `persistent:${entry.blockId}`,
  type: "persistent_longterm_recall",
  decay: entry.decay,
  confidence: entry.confidence,
  round: entry.round,
  tags: Array.from(new Set([...(entry.tags ?? []), "persistent", "recall", "longterm"])),
  content: entry.content,
  persistent_block_id: entry.blockId,
  content_state: "active",
  persistent_score: Math.max(0, Math.min(1, 0.5 * (1 - entry.decay) + 0.5 * entry.confidence)),
});

export class PersistentMemoryCoordinator {
  private readonly config: ResolvedPersistentMemoryConfig;
  private readonly store: PersistentMemoryStore;
  private readonly queue: PersistentCaptureQueue;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushRunning = false;

  constructor(args: {
    workspace: string;
    memoryConfig?: MemoryConfig;
  }) {
    this.config = resolvePersistentMemoryConfig({
      workspace: args.workspace,
      memoryConfig: args.memoryConfig,
    });
    this.store = new PersistentMemoryStore({
      storagePath: this.config.storagePath,
      maxEntries: this.config.maxEntries,
    });
    this.queue = new PersistentCaptureQueue(this.config.walPath);
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (this.config.pipeline.mode === "async_wal") {
      this.flushTimer = setInterval(() => {
        void this.flushCaptureQueue();
      }, this.config.pipeline.flushIntervalMs);
      if (this.queue.size() > 0) {
        await this.flushCaptureQueue();
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (this.config.pipeline.mode === "async_wal") {
      await withTimeout(
        async () => {
          while (this.queue.size() > 0) {
            await this.flushCaptureQueue();
          }
        },
        this.config.pipeline.flushOnShutdownTimeoutMs,
        undefined,
      );
    }
  }

  async beforeTask(session: AgentSession): Promise<void> {
    if (!this.config.enabled) return;

    const context = session.getContextSnapshot();
    const excludeBlockIds = new Set<string>();
    for (const tier of ["core", "working", "ephemeral", "longterm"] as const) {
      const blocks = context.memory[tier] ?? [];
      for (const block of blocks) {
        const raw =
          typeof (block as Record<string, unknown>).persistent_block_id === "string"
            ? ((block as Record<string, unknown>).persistent_block_id as string)
            : block.id;
        const canonical = canonicalizePersistentBlockId(raw);
        if (canonical) {
          excludeBlockIds.add(canonical);
        }
      }
    }

    const recalled = await withTimeout(
      async () =>
        this.store.recall({
          excludeBlockIds: Array.from(excludeBlockIds),
          limit: this.config.recallLimit,
        }),
      this.config.pipeline.recallTimeoutMs,
      [],
    );

    if (recalled.length === 0) {
      return;
    }

    session.mergeExtractedContext({
      memory: {
        longterm: recalled.map(toRecallBlock),
      },
    } as any);
  }

  async afterTask(session: AgentSession): Promise<void> {
    if (!this.config.enabled) return;

    const context = session.getContextSnapshot();
    const taskId = extractTaskId(context);
    const timestamp = Date.now();
    const candidates = listCaptureCandidates(context);
    if (candidates.length === 0) {
      return;
    }

    const payloads = candidates
      .map((block) => {
        const rawBlockId =
          typeof (block as Record<string, unknown>).persistent_block_id === "string"
            ? ((block as Record<string, unknown>).persistent_block_id as string)
            : block.id;
        const blockId = canonicalizePersistentBlockId(rawBlockId);
        if (!blockId) return null;
        return toPersistentEntryPayload({
          block,
          sourceTaskId: taskId,
          blockId,
          updatedAt: timestamp,
        });
      })
      .filter((item): item is ReturnType<typeof toPersistentEntryPayload> => item !== null);

    if (payloads.length === 0) {
      return;
    }

    if (this.config.pipeline.mode === "sync") {
      this.store.upsert(payloads);
      return;
    }

    for (const payload of payloads) {
      const job: PersistentCaptureJob = {
        jobId: Bun.randomUUIDv7(),
        taskId,
        blockId: payload.blockId,
        contentHash: hashPersistentContent(payload.content),
        payload,
        timestamp,
      };
      this.queue.enqueue(job);
    }

    void this.flushCaptureQueue();
  }

  private async flushCaptureQueue(): Promise<void> {
    if (this.flushRunning) {
      return;
    }

    this.flushRunning = true;
    try {
      const jobs = this.queue.peekBatch(this.config.pipeline.batchSize);
      if (jobs.length === 0) {
        return;
      }

      this.store.upsert(jobs.map((job) => job.payload));
      this.queue.ack(jobs.map((job) => job.jobId));
    } finally {
      this.flushRunning = false;
    }
  }
}
