import { join } from "node:path";
import type { ContextMemoryBlock, MemoryConfig } from "../../../types/agent";

export const DEFAULT_PERSISTENT_MEMORY_STORAGE_FILENAME = "persistent-memory.jsonl";
export const PERSISTENT_MEMORY_QUEUE_WAL_FILENAME = "memory-queue.wal";

export type PersistentCaptureJob = {
  jobId: string;
  taskId: string;
  blockId: string;
  contentHash: string;
  payload: {
    blockId: string;
    type: string;
    content: string;
    tags: string[];
    confidence: number;
    decay: number;
    round: number;
    sourceTaskId: string;
    updatedAt: number;
  };
  timestamp: number;
};

export type PersistentMemoryEntry = {
  blockId: string;
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  decay: number;
  round: number;
  sourceTaskId: string;
  updatedAt: number;
};

export type ResolvedPersistentMemoryConfig = {
  enabled: boolean;
  storagePath: string;
  walPath: string;
  recallLimit: number;
  maxEntries: number;
  pipeline: {
    mode: "sync" | "async_wal";
    recallTimeoutMs: number;
    batchSize: number;
    flushIntervalMs: number;
    flushOnShutdownTimeoutMs: number;
  };
};

const normalizePositiveInteger = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;

export const resolvePersistentMemoryConfig = (args: {
  workspace: string;
  memoryConfig?: MemoryConfig;
}): ResolvedPersistentMemoryConfig => {
  const persistent = args.memoryConfig?.persistent;

  const storagePath =
    typeof persistent?.storagePath === "string" && persistent.storagePath.trim() !== ""
      ? persistent.storagePath
      : join(args.workspace, ".agent", DEFAULT_PERSISTENT_MEMORY_STORAGE_FILENAME);

  const walPath =
    typeof persistent?.walPath === "string" && persistent.walPath.trim() !== ""
      ? persistent.walPath
      : join(args.workspace, ".agent", PERSISTENT_MEMORY_QUEUE_WAL_FILENAME);

  const mode = persistent?.pipeline?.mode === "sync" ? "sync" : "async_wal";

  return {
    enabled: persistent?.enabled ?? true,
    storagePath,
    walPath,
    recallLimit: normalizePositiveInteger(persistent?.recallLimit, 24),
    maxEntries: normalizePositiveInteger(persistent?.maxEntries, 4000),
    pipeline: {
      mode,
      recallTimeoutMs: normalizePositiveInteger(persistent?.pipeline?.recallTimeoutMs, 40),
      batchSize: normalizePositiveInteger(persistent?.pipeline?.batchSize, 32),
      flushIntervalMs: normalizePositiveInteger(persistent?.pipeline?.flushIntervalMs, 200),
      flushOnShutdownTimeoutMs: normalizePositiveInteger(
        persistent?.pipeline?.flushOnShutdownTimeoutMs,
        3000,
      ),
    },
  };
};

export const toPersistentEntryPayload = (args: {
  block: ContextMemoryBlock;
  sourceTaskId: string;
  blockId: string;
  updatedAt: number;
}): PersistentMemoryEntry => ({
  blockId: args.blockId,
  type: args.block.type,
  content: args.block.content,
  tags: args.block.tags,
  confidence: args.block.confidence,
  decay: args.block.decay,
  round: args.block.round,
  sourceTaskId: args.sourceTaskId,
  updatedAt: args.updatedAt,
});
