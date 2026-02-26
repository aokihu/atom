import { dirname, join } from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  addTodoItem,
  appendTodoEvent,
  cleanupTodoDbOnStartup,
  clearDoneTodoItems,
  getTodoDbCleanupTargets,
  getTodoProgressContext,
  getTodoProgressState,
  listTodoEvents,
  openTodoDatabase,
  readTodoProgressContextForWorkspace,
  removeTodoItem,
  setTodoItemDone,
} from "./todo_store";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-todo-store-test-"));
};

describe("todo store", () => {
  test("cleanupTodoDbOnStartup skips when db files do not exist", async () => {
    const workspace = await createWorkspaceTempDir();
    const result = await cleanupTodoDbOnStartup({ workspace });

    expect(result.skipped).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.removedFiles).toEqual([]);
  });

  test("cleanupTodoDbOnStartup removes db and sqlite sidecar files", async () => {
    const workspace = await createWorkspaceTempDir();
    for (const target of getTodoDbCleanupTargets(workspace)) {
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, "x");
    }

    const result = await cleanupTodoDbOnStartup({ workspace });
    expect(result.skipped).toBe(false);
    expect(result.removed).toBeGreaterThan(0);

    for (const target of getTodoDbCleanupTargets(workspace)) {
      expect(await Bun.file(target).exists()).toBe(false);
    }
  });

  test("cleanupTodoDbOnStartup throws and includes failing filepath", async () => {
    const workspace = await createWorkspaceTempDir();
    const [firstTarget] = getTodoDbCleanupTargets(workspace);

    const resultPromise = cleanupTodoDbOnStartup(
      { workspace },
      {
        exists: async (filepath) => filepath === firstTarget,
        remove: async (filepath) => {
          throw new Error(`boom:${filepath}`);
        },
      },
    );

    await expect(resultPromise).rejects.toThrow(firstTarget);
  });

  test("initializes dual tables todo_items and todo_events", async () => {
    const workspace = await createWorkspaceTempDir();
    const db = await openTodoDatabase(workspace);
    try {
      const tables = (db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
        .all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(tables).toContain("todo_items");
      expect(tables).toContain("todo_events");

      const indexes = (db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_todo_%'")
        .all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        "idx_todo_items_status",
        "idx_todo_events_todo_id",
        "idx_todo_events_event_type",
        "idx_todo_events_created_at",
      ]));
    } finally {
      db.close();
    }
  });

  test("todo progress uses planned order and flags skipped completion in summary", async () => {
    const workspace = await createWorkspaceTempDir();

    expect(readTodoProgressContextForWorkspace(workspace)).toEqual({
      summary: "暂无TODO",
      total: 0,
      step: 0,
    });

    const db = await openTodoDatabase(workspace);
    try {
      const first = addTodoItem(db, { title: "first" });
      const second = addTodoItem(db, { title: "second" });
      const third = addTodoItem(db, { title: "third" });
      expect(first && second && third).toBeTruthy();

      let progress = getTodoProgressContext(db);
      expect(progress).toEqual({
        summary: "进行中 0/3（当前第1步）",
        total: 3,
        step: 1,
      });

      setTodoItemDone(db, { id: second!.id, done: true });
      progress = getTodoProgressContext(db);
      expect(progress.total).toBe(3);
      expect(progress.step).toBe(1);
      expect(progress.summary).toContain("存在跳步");

      setTodoItemDone(db, { id: first!.id, done: true });
      progress = getTodoProgressContext(db);
      expect(progress.step).toBe(3);

      setTodoItemDone(db, { id: third!.id, done: true });
      progress = getTodoProgressContext(db);
      expect(progress).toEqual({
        summary: "已完成 3/3",
        total: 3,
        step: 3,
      });

      const state = getTodoProgressState(db);
      expect(state.items.map((item) => item.id)).toEqual([first!.id, second!.id, third!.id]);
    } finally {
      db.close();
    }
  });

  test("remove and clear_done return removed raw items for event logging", async () => {
    const workspace = await createWorkspaceTempDir();
    const db = await openTodoDatabase(workspace);
    try {
      const a = addTodoItem(db, { title: "a" });
      const b = addTodoItem(db, { title: "b" });
      expect(a && b).toBeTruthy();
      setTodoItemDone(db, { id: a!.id, done: true });

      const removed = removeTodoItem(db, b!.id);
      expect(removed.removed).toBe(true);
      expect(removed.item?.id).toBe(b!.id);

      const cleared = clearDoneTodoItems(db);
      expect(cleared.deletedCount).toBe(1);
      expect(cleared.removedItems.map((item) => item.id)).toEqual([a!.id]);
    } finally {
      db.close();
    }
  });

  test("appendTodoEvent stores versioned payload envelope", async () => {
    const workspace = await createWorkspaceTempDir();
    const db = await openTodoDatabase(workspace);
    try {
      const item = addTodoItem(db, { title: "event target" });
      expect(item).not.toBeNull();
      const progress = getTodoProgressContext(db);

      appendTodoEvent(db, {
        todoId: item!.id,
        eventType: "update",
        actor: "agent",
        toolName: "todo_update",
        payload: {
          v: 1,
          input: { id: item!.id, title: "event target" },
          before: item,
          after: item,
          removedItems: [],
          progress,
        },
      });

      const events = listTodoEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("update");
      expect(events[0]!.todoId).toBe(item!.id);

      const payload = JSON.parse(events[0]!.payloadJson);
      expect(payload.v).toBe(1);
      expect(payload.input.id).toBe(item!.id);
      expect(payload.progress).toEqual(progress);
    } finally {
      db.close();
    }
  });
});
