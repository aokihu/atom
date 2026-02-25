import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getTodoDbPath, todoTool } from "./todo";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-todo-test-"));
};

const executeTool = async (context: Record<string, unknown>, input: unknown) =>
  await (todoTool(context as any) as any).execute(input);

describe("todo tool", () => {
  test("adds and lists todo items using workspace sqlite db", async () => {
    const workspace = await createWorkspaceTempDir();

    const addResult = await executeTool(
      { workspace },
      { action: "add", title: "  first task  ", note: "hello" },
    );

    expect(addResult.success).toBe(true);
    expect(addResult.item.title).toBe("first task");
    expect(addResult.item.status).toBe("open");
    expect(addResult.dbPath).toBe(getTodoDbPath(workspace));
    expect(await Bun.file(getTodoDbPath(workspace)).exists()).toBe(true);

    const listResult = await executeTool(
      { workspace },
      { action: "list", status: "open" },
    );

    expect(listResult.action).toBe("list");
    expect(listResult.count).toBe(1);
    expect(listResult.items[0].title).toBe("first task");
  });

  test("set_done toggles todo completion status", async () => {
    const workspace = await createWorkspaceTempDir();

    const first = await executeTool({ workspace }, { action: "add", title: "task A" });
    const second = await executeTool({ workspace }, { action: "add", title: "task B" });

    const doneResult = await executeTool(
      { workspace },
      { action: "set_done", id: first.item.id },
    );

    expect(doneResult.success).toBe(true);
    expect(doneResult.item.status).toBe("done");
    expect(doneResult.item.completedAt).not.toBeNull();

    const doneList = await executeTool({ workspace }, { action: "list", status: "done" });
    expect(doneList.count).toBe(1);
    expect(doneList.items[0].id).toBe(first.item.id);

    const reopenResult = await executeTool(
      { workspace },
      { action: "set_done", id: first.item.id, done: false },
    );
    expect(reopenResult.item.status).toBe("open");
    expect(reopenResult.item.completedAt).toBeNull();

    const openList = await executeTool({ workspace }, { action: "list", status: "open" });
    expect(openList.count).toBe(2);
    expect(openList.items.some((item: any) => item.id === second.item.id)).toBe(true);
  });

  test("updates title and note", async () => {
    const workspace = await createWorkspaceTempDir();

    const created = await executeTool(
      { workspace },
      { action: "add", title: "old title", note: "old note" },
    );

    const updated = await executeTool(
      { workspace },
      {
        action: "update",
        id: created.item.id,
        title: "new title",
        note: "new note",
      },
    );

    expect(updated.success).toBe(true);
    expect(updated.item.title).toBe("new title");
    expect(updated.item.note).toBe("new note");
  });

  test("removes and clears completed items", async () => {
    const workspace = await createWorkspaceTempDir();

    const a = await executeTool({ workspace }, { action: "add", title: "a" });
    const b = await executeTool({ workspace }, { action: "add", title: "b" });

    await executeTool({ workspace }, { action: "set_done", id: a.item.id });

    const clearResult = await executeTool({ workspace }, { action: "clear_done" });
    expect(clearResult.success).toBe(true);
    expect(clearResult.deletedCount).toBe(1);

    const removeResult = await executeTool({ workspace }, { action: "remove", id: b.item.id });
    expect(removeResult.success).toBe(true);

    const listResult = await executeTool({ workspace }, { action: "list" });
    expect(listResult.count).toBe(0);
  });

  test("returns error when workspace is unavailable", async () => {
    const result = await executeTool({}, { action: "list" });
    expect(result.error).toContain("Workspace unavailable");
  });
});
