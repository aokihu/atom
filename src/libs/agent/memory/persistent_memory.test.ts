import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentSession } from "../session/agent_session";
import {
  closePersistentMemoryDatabase,
  openPersistentMemoryDatabase,
} from "./persistent_db";
import { PersistentMemoryCoordinator } from "./persistent_coordinator";
import { PersistentMemoryStore } from "./persistent_store";

const createTempWorkspace = async (withAgentDir = true) => {
  const workspace = await mkdtemp(join(tmpdir(), "atom-pmem-"));
  if (withAgentDir) {
    await mkdir(join(workspace, ".agent"), { recursive: true });
  }
  return workspace;
};

const cleanupWorkspace = async (workspace: string) => {
  await rm(workspace, { recursive: true, force: true });
};

const createSession = (workspace: string) =>
  new AgentSession({
    workspace,
    systemPrompt: "system",
  });

const coreBlock = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "core:project:ts-style",
  type: "project_constraint",
  decay: 0.1,
  confidence: 0.9,
  round: 1,
  tags: ["project", "typescript"],
  content: "Project uses TypeScript and Bun. Prefer Bun test for local validation.",
  ...overrides,
});

describe("persistent memory db/store", () => {
  test("initializes schema when .agent exists", async () => {
    const workspace = await createTempWorkspace(true);
    let handle;
    try {
      handle = openPersistentMemoryDatabase(workspace);
      const table = handle.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'persistent_memory_entries'",
        )
        .get() as { name: string } | null;
      expect(table?.name).toBe("persistent_memory_entries");
    } finally {
      await closePersistentMemoryDatabase(handle);
      await cleanupWorkspace(workspace);
    }
  });

  test("falls back to non-FTS mode when FTS table creation fails", async () => {
    const workspace = await createTempWorkspace(true);
    const originalExec = Database.prototype.exec;
    let handle;

    (Database.prototype as any).exec = function patchedExec(this: Database, sql: string) {
      if (typeof sql === "string" && sql.includes("CREATE VIRTUAL TABLE IF NOT EXISTS persistent_memory_fts")) {
        throw new Error("fts5 unavailable");
      }
      return originalExec.call(this, sql);
    };

    try {
      handle = openPersistentMemoryDatabase(workspace);
      expect(handle.runtime.ftsEnabled).toBe(false);
    } finally {
      (Database.prototype as any).exec = originalExec;
      await closePersistentMemoryDatabase(handle);
      await cleanupWorkspace(workspace);
    }
  });

  test("upsert inserts, preserves updated_at on unchanged, and updates on content change", async () => {
    const workspace = await createTempWorkspace(true);
    let handle;
    try {
      handle = openPersistentMemoryDatabase(workspace);
      const store = new PersistentMemoryStore(handle);

      const inserted = await store.upsertCoreBlocks({
        blocks: [coreBlock()],
        sourceTaskId: "task-1",
      });
      expect(inserted).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 0 });

      let entries = await store.listAllEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.blockId).toBe("core:project:ts-style");
      const firstUpdatedAt = entries[0]!.updatedAt;

      const unchanged = await store.upsertCoreBlocks({
        blocks: [coreBlock({ round: 2 }) as any],
        sourceTaskId: "task-2",
      });
      expect(unchanged).toEqual({ inserted: 0, updated: 0, unchanged: 1, skipped: 0 });

      entries = await store.listAllEntries();
      expect(entries[0]?.lastSeenRound).toBe(2);
      expect(entries[0]?.sourceTaskId).toBe("task-2");
      expect(entries[0]?.updatedAt).toBe(firstUpdatedAt);

      await Bun.sleep(5);
      const updated = await store.upsertCoreBlocks({
        blocks: [
          coreBlock({
            round: 3,
            content: "Project uses TypeScript, Bun, and Bun test. Keep scripts Bun-first.",
          }) as any,
        ],
        sourceTaskId: "task-3",
      });
      expect(updated).toEqual({ inserted: 0, updated: 1, unchanged: 0, skipped: 0 });

      entries = await store.listAllEntries();
      expect(entries[0]?.lastSeenRound).toBe(3);
      expect(entries[0]?.sourceTaskId).toBe("task-3");
      expect(entries[0]?.content).toContain("Bun-first");
      expect(entries[0]!.updatedAt).toBeGreaterThanOrEqual(firstUpdatedAt);
    } finally {
      await closePersistentMemoryDatabase(handle);
      await cleanupWorkspace(workspace);
    }
  });

  test("searchRelevant returns ranked hits and markRecalled updates counters", async () => {
    const workspace = await createTempWorkspace(true);
    let handle;
    try {
      handle = openPersistentMemoryDatabase(workspace);
      const store = new PersistentMemoryStore(handle);

      await store.upsertCoreBlocks({
        blocks: [
          coreBlock({
            id: "core:project:typescript",
            content: "TypeScript project. Parser and build scripts run with Bun.",
            tags: ["typescript", "parser"],
          }) as any,
          coreBlock({
            id: "core:project:docs",
            content: "Documentation style prefers concise examples.",
            tags: ["docs"],
            confidence: 0.8,
          }) as any,
        ],
      });

      const search = await store.searchRelevant({
        query: "typescript parser",
        limit: 5,
        mode: "like",
      });
      expect(search.hits.length).toBeGreaterThan(0);
      expect(search.modeUsed).toBe("like");
      expect(search.hits[0]?.entry.blockId).toBe("core:project:typescript");

      const targetId = search.hits[0]!.entry.id;
      await store.markRecalled([targetId]);
      const entries = await store.listAllEntries();
      const updated = entries.find((entry) => entry.id === targetId);
      expect(updated?.recallCount).toBe(1);
      expect(typeof updated?.lastRecalledAt).toBe("number");
    } finally {
      await closePersistentMemoryDatabase(handle);
      await cleanupWorkspace(workspace);
    }
  });
});

describe("persistent memory coordinator", () => {
  test("auto-creates .agent directory when missing", async () => {
    const workspace = await createTempWorkspace(false);
    try {
      const coordinator = PersistentMemoryCoordinator.initialize({
        workspace,
        config: { enabled: true },
      });
      expect(coordinator.status.enabled).toBe(true);
      expect(coordinator.status.available).toBe(true);
      expect(await Bun.file(join(workspace, ".agent", "memory.db")).exists()).toBe(true);

      const session = createSession(workspace);
      await expect(coordinator.hooks.beforeTask(session, "hello")).resolves.toBeUndefined();
      await expect(coordinator.hooks.afterTask(session, { mode: "detailed" })).resolves.toBeUndefined();
      await coordinator.dispose();
    } finally {
      await cleanupWorkspace(workspace);
    }
  });

  test("fails open when .agent path is blocked by a file", async () => {
    const workspace = await createTempWorkspace(false);
    await writeFile(join(workspace, ".agent"), "blocked", "utf8");
    try {
      const coordinator = PersistentMemoryCoordinator.initialize({
        workspace,
        config: { enabled: true },
      });
      expect(coordinator.status.enabled).toBe(true);
      expect(coordinator.status.available).toBe(false);

      const session = createSession(workspace);
      await expect(coordinator.hooks.beforeTask(session, "hello")).resolves.toBeUndefined();
      await expect(coordinator.hooks.afterTask(session, { mode: "detailed" })).resolves.toBeUndefined();
    } finally {
      await cleanupWorkspace(workspace);
    }
  });

  test("captures core memory and recalls into ephemeral with duplicate-core skip", async () => {
    const workspace = await createTempWorkspace(true);
    try {
      const coordinator = PersistentMemoryCoordinator.initialize({
        workspace,
        config: {
          enabled: true,
          autoCapture: true,
          autoRecall: true,
          searchMode: "like",
          maxRecallItems: 6,
          minCaptureConfidence: 0.7,
        },
      });
      expect(coordinator.status.available).toBe(true);

      const session1 = createSession(workspace);
      session1.mergeSystemContextPatch({
        memory: {
          core: [coreBlock()],
        },
        active_task_meta: {
          id: "task-a",
        },
      } as any);

      await coordinator.hooks.afterTask(session1, {
        mode: "detailed",
        completed: true,
        finishReason: "stop",
      });

      const session2 = createSession(workspace);
      await coordinator.hooks.beforeTask(session2, "What is our TypeScript and Bun testing setup?");
      const afterRecall = session2.getContextSnapshot();
      expect(afterRecall.memory.ephemeral.length).toBeGreaterThan(0);
      const recalled = afterRecall.memory.ephemeral.find((block) => block.type === "persistent_recall");
      expect(recalled?.id).toBe("persistent:core:project:ts-style");
      expect((recalled as any)?.persistent_block_id).toBe("core:project:ts-style");
      expect(recalled?.tags).toContain("persistent");
      expect(recalled?.tags).toContain("recall");

      const session3 = createSession(workspace);
      session3.mergeSystemContextPatch({
        memory: {
          core: [coreBlock()],
        },
      } as any);
      await coordinator.hooks.beforeTask(session3, "TypeScript and Bun?");
      const duplicateSkipped = session3.getContextSnapshot();
      expect(
        duplicateSkipped.memory.ephemeral.some(
          (block) => (block as any).persistent_block_id === "core:project:ts-style",
        ),
      ).toBe(false);

      await coordinator.dispose();
    } finally {
      await cleanupWorkspace(workspace);
    }
  });
});
