import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentCaptureQueue } from "./persistent_queue";

describe("persistent_queue", () => {
  test("append ack and replay from wal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-pqueue-"));
    const walPath = join(workspace, "memory-queue.wal");

    const q1 = new PersistentCaptureQueue(walPath);
    q1.enqueue({
      jobId: "j1",
      taskId: "t1",
      blockId: "working:a",
      contentHash: "h1",
      payload: {
        blockId: "working:a",
        type: "task",
        content: "a",
        tags: [],
        confidence: 0.9,
        decay: 0.2,
        round: 1,
        sourceTaskId: "t1",
        updatedAt: Date.now(),
      },
      timestamp: 1,
    });
    q1.enqueue({
      jobId: "j2",
      taskId: "t1",
      blockId: "working:b",
      contentHash: "h2",
      payload: {
        blockId: "working:b",
        type: "task",
        content: "b",
        tags: [],
        confidence: 0.9,
        decay: 0.2,
        round: 1,
        sourceTaskId: "t1",
        updatedAt: Date.now(),
      },
      timestamp: 2,
    });

    expect(q1.size()).toBe(2);

    const replay = new PersistentCaptureQueue(walPath);
    expect(replay.size()).toBe(2);
    replay.ack(["j1"]);
    expect(replay.size()).toBe(1);

    const replay2 = new PersistentCaptureQueue(walPath);
    expect(replay2.size()).toBe(1);
    expect(replay2.peekBatch(10).map((job) => job.jobId)).toEqual(["j2"]);

    await rm(workspace, { recursive: true, force: true });
  });

  test("ignores malformed wal lines", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-pqueue-malformed-"));
    const walPath = join(workspace, "memory-queue.wal");

    await Bun.write(walPath, ["{invalid-json}", "", JSON.stringify({ jobId: "j1", taskId: "t1" })].join("\n"));

    const queue = new PersistentCaptureQueue(walPath);
    expect(queue.size()).toBe(1);

    await rm(workspace, { recursive: true, force: true });
  });
});
