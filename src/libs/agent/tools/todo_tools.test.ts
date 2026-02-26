import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ToolExecutionContext } from "./types";
import {
  todoAddTool,
  todoClearDoneTool,
  todoCompleteTool,
  todoListTool,
  todoRemoveTool,
  todoReopenTool,
  todoUpdateTool,
} from "./todo_tools";
import { getTodoDbPath, listTodoEvents, openTodoDatabase } from "./todo_store";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-todo-tools-test-"));
};

const executeTool = async (
  factory: (context: ToolExecutionContext) => unknown,
  context: Record<string, unknown>,
  input: unknown,
) => await ((factory as any)(context as any) as any).execute(input);

const createDenyTodoContext = (workspace: string) => ({
  workspace,
  permissions: {
    permissions: {
      todo: {
        deny: [".*"],
      },
    },
  },
});

const expectTodoProgress = (value: any) => {
  expect(value && typeof value === "object" && !Array.isArray(value)).toBe(true);
  expect(typeof value.summary).toBe("string");
  expect(typeof value.total).toBe("number");
  expect(typeof value.step).toBe("number");
  expect((value as any).cursor).toBeUndefined();
};

describe("todo split tools", () => {
  test("todo_add and todo_list persist items and return todo progress snapshot", async () => {
    const workspace = await createWorkspaceTempDir();

    const addResult = await executeTool(todoAddTool, { workspace }, { title: "  first task  ", note: "hello" });
    expect(addResult.success).toBe(true);
    expect(addResult.item.title).toBe("first task");
    expect(addResult.item.status).toBe("open");
    expectTodoProgress(addResult.todo);
    expect(addResult.todo.step).toBe(1);
    expect(await Bun.file(getTodoDbPath(workspace)).exists()).toBe(true);

    const listResult = await executeTool(todoListTool, { workspace }, { status: "open" });
    expect(listResult.success).toBe(true);
    expect(listResult.count).toBe(1);
    expect(listResult.items[0].title).toBe("first task");
    expectTodoProgress(listResult.todo);
  });

  test("todo_list returns planned order (id ASC)", async () => {
    const workspace = await createWorkspaceTempDir();
    const a = await executeTool(todoAddTool, { workspace }, { title: "task A" });
    const b = await executeTool(todoAddTool, { workspace }, { title: "task B" });
    const c = await executeTool(todoAddTool, { workspace }, { title: "task C" });

    await executeTool(todoCompleteTool, { workspace }, { id: b.item.id });
    const list = await executeTool(todoListTool, { workspace }, { status: "all" });

    expect(list.items.map((item: any) => item.id)).toEqual([a.item.id, b.item.id, c.item.id]);
  });

  test("todo_complete and todo_reopen toggle completion status and update step", async () => {
    const workspace = await createWorkspaceTempDir();
    const first = await executeTool(todoAddTool, { workspace }, { title: "task A" });
    await executeTool(todoAddTool, { workspace }, { title: "task B" });

    const doneResult = await executeTool(todoCompleteTool, { workspace }, { id: first.item.id });
    expect(doneResult.success).toBe(true);
    expect(doneResult.item.status).toBe("done");
    expect(doneResult.item.completedAt).not.toBeNull();
    expectTodoProgress(doneResult.todo);
    expect(doneResult.todo.step).toBe(2);

    const reopenResult = await executeTool(todoReopenTool, { workspace }, { id: first.item.id });
    expect(reopenResult.success).toBe(true);
    expect(reopenResult.item.status).toBe("open");
    expect(reopenResult.item.completedAt).toBeNull();
    expectTodoProgress(reopenResult.todo);
    expect(reopenResult.todo.step).toBe(1);
  });

  test("todo_update updates title and note and validates at least one field", async () => {
    const workspace = await createWorkspaceTempDir();
    const created = await executeTool(todoAddTool, { workspace }, { title: "old", note: "old note" });

    const updated = await executeTool(todoUpdateTool, { workspace }, {
      id: created.item.id,
      title: "new title",
      note: "new note",
    });
    expect(updated.success).toBe(true);
    expect(updated.item.title).toBe("new title");
    expect(updated.item.note).toBe("new note");
    expectTodoProgress(updated.todo);

    const invalid = await executeTool(todoUpdateTool, { workspace }, { id: created.item.id });
    expect(invalid.error).toBe("Invalid todo_update input");
    expect(String(invalid.detail ?? "")).toContain("At least one of title or note is required");
  });

  test("todo_remove and todo_clear_done remove correct items and return progress", async () => {
    const workspace = await createWorkspaceTempDir();
    const a = await executeTool(todoAddTool, { workspace }, { title: "a" });
    const b = await executeTool(todoAddTool, { workspace }, { title: "b" });

    await executeTool(todoCompleteTool, { workspace }, { id: a.item.id });
    const clearDone = await executeTool(todoClearDoneTool, { workspace }, {});
    expect(clearDone.success).toBe(true);
    expect(clearDone.deletedCount).toBe(1);
    expectTodoProgress(clearDone.todo);

    const remove = await executeTool(todoRemoveTool, { workspace }, { id: b.item.id });
    expect(remove.success).toBe(true);
    expectTodoProgress(remove.todo);
    expect(remove.todo.total).toBe(0);

    const list = await executeTool(todoListTool, { workspace }, {});
    expect(list.success).toBe(true);
    expect(list.count).toBe(0);
    expect(list.todo.total).toBe(0);
  });

  test("writes todo_events payloads for mutating operations", async () => {
    const workspace = await createWorkspaceTempDir();
    const created = await executeTool(todoAddTool, { workspace }, { title: "track me" });
    await executeTool(todoUpdateTool, { workspace }, { id: created.item.id, note: "n1" });
    await executeTool(todoCompleteTool, { workspace }, { id: created.item.id });
    await executeTool(todoReopenTool, { workspace }, { id: created.item.id });
    await executeTool(todoRemoveTool, { workspace }, { id: created.item.id });

    const db = await openTodoDatabase(workspace);
    try {
      const events = listTodoEvents(db);
      expect(events.map((event) => event.eventType)).toEqual([
        "add",
        "update",
        "complete",
        "reopen",
        "remove",
      ]);

      for (const event of events) {
        const payload = JSON.parse(event.payloadJson);
        expect(payload.v).toBe(1);
        expect(payload.progress && typeof payload.progress === "object").toBe(true);
      }
    } finally {
      db.close();
    }
  });

  test("strict schema rejects dbPath and invalid ids/limits", async () => {
    const workspace = await createWorkspaceTempDir();

    const unknownField = await executeTool(todoListTool, { workspace }, {
      status: "all",
      dbPath: "/tmp/hack.db",
    } as any);
    expect(unknownField.error).toBe("Invalid todo_list input");
    expect(String(unknownField.detail ?? "")).toContain("Unrecognized key");

    const badId = await executeTool(todoCompleteTool, { workspace }, { id: 0 });
    expect(badId.error).toBe("Invalid todo_complete input");

    const badLimit = await executeTool(todoListTool, { workspace }, { limit: 9999 });
    expect(badLimit.error).toBe("Invalid todo_list input");
  });

  test("returns errors when workspace is unavailable or todo permission denied", async () => {
    const noWorkspace = await executeTool(todoListTool, {}, {});
    expect(String(noWorkspace.error)).toContain("Workspace unavailable");

    const workspace = await createWorkspaceTempDir();
    const denied = await executeTool(todoListTool, createDenyTodoContext(workspace), {});
    expect(denied.error).toBe("Permission denied: todo path not allowed");
  });
});
