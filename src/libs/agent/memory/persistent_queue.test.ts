import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersistentCaptureQueue } from "./persistent_queue";

const createWorkspace = async () => await mkdtemp(join(tmpdir(), "atom-memory-queue-"));

describe("persistent_queue", () => {
  test("enqueue + ack + replay from wal", async () => {
    const workspace = await createWorkspace();
    try {
      const queue = PersistentCaptureQueue.initialize({ workspace });
      expect(queue.size()).toBe(0);

      await queue.enqueue({
        jobId: "job-1",
        createdAt: 1,
        sourceTier: "core",
        sourceTaskId: "task-1",
        blockId: "core:a",
        contentHash: "h1",
        block: {
          id: "core:a",
          type: "fact",
          decay: 0.1,
          confidence: 0.9,
          round: 1,
          tags: ["a"],
          content: "A",
        },
      });

      await queue.enqueue({
        jobId: "job-2",
        createdAt: 2,
        sourceTier: "longterm",
        sourceTaskId: null,
        blockId: "longterm:b",
        contentHash: "h2",
        block: {
          id: "longterm:b",
          type: "fact",
          decay: 0.2,
          confidence: 0.8,
          round: 1,
          tags: ["b"],
          content: "B",
        },
      });

      const replayed = PersistentCaptureQueue.initialize({ workspace });
      expect(replayed.size()).toBe(2);
      expect(replayed.peekBatch(10).map((job) => job.jobId)).toEqual(["job-1", "job-2"]);

      const removed = await replayed.ack(["job-1"]);
      expect(removed).toBe(1);
      expect(replayed.size()).toBe(1);
      expect(replayed.peekBatch(10).map((job) => job.jobId)).toEqual(["job-2"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("skips malformed wal lines", async () => {
    const workspace = await createWorkspace();
    try {
      const walPath = join(workspace, ".agent", "memory-queue.wal");
      await mkdir(join(workspace, ".agent"), { recursive: true });
      await writeFile(
        walPath,
        [
          "{not-json}",
          JSON.stringify({ jobId: "x" }),
          JSON.stringify({
            jobId: "ok",
            createdAt: 1,
            sourceTier: "core",
            sourceTaskId: null,
            blockId: "core:x",
            contentHash: "h",
            block: {
              id: "core:x",
              type: "fact",
              decay: 0.1,
              confidence: 0.9,
              round: 1,
              tags: [],
              content: "ok",
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const queue = PersistentCaptureQueue.initialize({ workspace });
      expect(queue.size()).toBe(1);
      expect(queue.peekBatch(10)[0]?.jobId).toBe("ok");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
