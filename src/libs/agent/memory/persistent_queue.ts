import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PersistentCaptureJob } from "./persistent_types";

const parseQueueLines = (content: string): PersistentCaptureJob[] => {
  const jobs: PersistentCaptureJob[] = [];
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as PersistentCaptureJob;
      if (typeof parsed.jobId === "string" && typeof parsed.taskId === "string") {
        jobs.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return jobs;
};

const serializeQueueLines = (jobs: PersistentCaptureJob[]): string =>
  jobs.map((job) => JSON.stringify(job)).join("\n");

export class PersistentCaptureQueue {
  private readonly walPath: string;
  private readonly jobs = new Map<string, PersistentCaptureJob>();

  constructor(walPath: string) {
    this.walPath = walPath;
    this.bootstrap();
  }

  private bootstrap(): void {
    try {
      const content = readFileSync(this.walPath, "utf8");
      const jobs = parseQueueLines(content);
      for (const job of jobs) {
        this.jobs.set(job.jobId, job);
      }
    } catch {
      // ignore not found and malformed files
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.walPath), { recursive: true });
    writeFileSync(this.walPath, serializeQueueLines(this.listAll()), "utf8");
  }

  enqueue(job: PersistentCaptureJob): void {
    this.jobs.set(job.jobId, job);
    this.persist();
  }

  peekBatch(batchSize: number): PersistentCaptureJob[] {
    const normalized = Math.max(1, Math.floor(batchSize));
    return this.listAll().slice(0, normalized);
  }

  ack(jobIds: string[]): void {
    if (jobIds.length === 0) return;
    for (const id of jobIds) {
      this.jobs.delete(id);
    }
    this.persist();
  }

  size(): number {
    return this.jobs.size;
  }

  listAll(): PersistentCaptureJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.jobId.localeCompare(b.jobId);
    });
  }
}

export const __persistentQueueInternals = {
  parseQueueLines,
  serializeQueueLines,
};
