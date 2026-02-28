import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentMemoryStore, canonicalizePersistentBlockId } from "./persistent_store";

describe("persistent_store", () => {
  test("canonicalizePersistentBlockId strips repeated prefixes", () => {
    expect(canonicalizePersistentBlockId("persistent:persistent:working:abc")).toBe("working:abc");
    expect(canonicalizePersistentBlockId("working:working:abc")).toBe("working:abc");
  });

  test("upsert ignores recall memory types", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-pstore-"));
    const storagePath = join(workspace, "persistent-memory.jsonl");

    const store = new PersistentMemoryStore({
      storagePath,
      maxEntries: 20,
    });

    store.upsert([
      {
        blockId: "working:a",
        type: "persistent_recall",
        content: "x",
        tags: [],
        confidence: 0.9,
        decay: 0.1,
        round: 1,
        sourceTaskId: "t1",
        updatedAt: 1,
      },
      {
        blockId: "working:b",
        type: "task",
        content: "y",
        tags: [],
        confidence: 0.9,
        decay: 0.1,
        round: 1,
        sourceTaskId: "t1",
        updatedAt: 2,
      },
    ]);

    expect(store.listAll().map((item) => item.blockId)).toEqual(["working:b"]);
    await rm(workspace, { recursive: true, force: true });
  });
});
