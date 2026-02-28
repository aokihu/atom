import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PERSISTENT_MEMORY_DB_DIR,
  PERSISTENT_MEMORY_QUEUE_WAL_FILENAME,
  type PersistentCaptureJob,
} from "./persistent_types";

type LoggerLike = Pick<Console, "warn">;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidCaptureJob = (value: unknown): value is PersistentCaptureJob => {
  if (!isPlainObject(value)) return false;
  if (typeof value.jobId !== "string" || value.jobId.trim() === "") return false;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
  if (value.sourceTier !== "core" && value.sourceTier !== "longterm") return false;
  if (value.sourceTaskId !== null && typeof value.sourceTaskId !== "string") return false;
  if (typeof value.blockId !== "string" || value.blockId.trim() === "") return false;
  if (typeof value.contentHash !== "string" || value.contentHash.trim() === "") return false;
  if (!isPlainObject(value.block)) return false;
  return true;
};

const toJobLine = (job: PersistentCaptureJob): string => `${JSON.stringify(job)}\n`;

export class PersistentCaptureQueue {
  private readonly walPath: string;
  private readonly logger: LoggerLike;
  private jobs: PersistentCaptureJob[] = [];

  private constructor(args: { walPath: string; logger: LoggerLike }) {
    this.walPath = args.walPath;
    this.logger = args.logger;
  }

  static initialize(args: {
    workspace: string;
    logger?: LoggerLike;
  }): PersistentCaptureQueue {
    const walPath = join(args.workspace, PERSISTENT_MEMORY_DB_DIR, PERSISTENT_MEMORY_QUEUE_WAL_FILENAME);
    const queue = new PersistentCaptureQueue({
      walPath,
      logger: args.logger ?? console,
    });
    queue.loadFromWalSync();
    return queue;
  }

  private async ensureWalDirectory() {
    await mkdir(dirname(this.walPath), { recursive: true });
  }

  private loadFromWalSync() {
    if (!existsSync(this.walPath)) {
      return;
    }

    let content = "";
    try {
      content = readFileSync(this.walPath, "utf8");
    } catch {
      this.logger.warn("[memory] failed to read capture WAL file during startup");
      return;
    }

    if (content.trim() === "") {
      this.jobs = [];
      return;
    }

    const parsedJobs: PersistentCaptureJob[] = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidCaptureJob(parsed)) {
          parsedJobs.push(parsed);
          continue;
        }
        this.logger.warn("[memory] skip malformed WAL capture job record");
      } catch {
        this.logger.warn("[memory] skip invalid WAL JSON line");
      }
    }

    this.jobs = parsedJobs;
  }

  size(): number {
    return this.jobs.length;
  }

  async enqueue(job: PersistentCaptureJob): Promise<void> {
    await this.ensureWalDirectory();
    this.jobs.push(structuredClone(job));
    await appendFile(this.walPath, toJobLine(job), "utf8");
  }

  peekBatch(limit: number): PersistentCaptureJob[] {
    const safeLimit = Math.max(1, Math.trunc(limit));
    return this.jobs.slice(0, safeLimit).map((job) => structuredClone(job));
  }

  async ack(jobIds: Iterable<string>): Promise<number> {
    const ids = new Set<string>();
    for (const id of jobIds) {
      if (typeof id === "string" && id.trim() !== "") {
        ids.add(id);
      }
    }

    if (ids.size === 0 || this.jobs.length === 0) {
      return 0;
    }

    const previous = this.jobs.length;
    this.jobs = this.jobs.filter((job) => !ids.has(job.jobId));
    const removed = previous - this.jobs.length;
    if (removed <= 0) {
      return 0;
    }

    await this.rewriteWal();
    return removed;
  }

  async rewriteWal(): Promise<void> {
    await this.ensureWalDirectory();
    const payload = this.jobs.map((job) => toJobLine(job)).join("");
    await writeFile(this.walPath, payload, "utf8");
  }

  async drainAll(): Promise<PersistentCaptureJob[]> {
    const all = this.jobs.map((job) => structuredClone(job));
    this.jobs = [];
    await this.rewriteWal();
    return all;
  }

  getWalPath(): string {
    return this.walPath;
  }
}
