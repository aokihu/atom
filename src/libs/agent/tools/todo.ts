import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type TodoStatus = "open" | "done";

type TodoRow = {
  id: number;
  title: string;
  note: string;
  status: TodoStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type TodoItem = {
  id: number;
  title: string;
  note: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

const TODO_DB_DIR = ".agent";
const TODO_DB_FILENAME = "todo.db";
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

const listActionSchema = z.object({
  action: z.literal("list"),
  status: z.enum(["all", "open", "done"]).optional(),
  limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
}).strict();

const addActionSchema = z.object({
  action: z.literal("add"),
  title: z.string(),
  note: z.string().optional(),
}).strict();

const updateActionSchema = z.object({
  action: z.literal("update"),
  id: z.number().int().positive(),
  title: z.string().optional(),
  note: z.string().optional(),
}).strict();

const setDoneActionSchema = z.object({
  action: z.literal("set_done"),
  id: z.number().int().positive(),
  done: z.boolean().optional(),
}).strict();

const removeActionSchema = z.object({
  action: z.literal("remove"),
  id: z.number().int().positive(),
}).strict();

const clearDoneActionSchema = z.object({
  action: z.literal("clear_done"),
}).strict();

const todoInputSchema = z.object({
  action: z.enum(["list", "add", "update", "set_done", "remove", "clear_done"]),
  id: z.number().int().positive().optional(),
  title: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(["all", "open", "done"]).optional(),
  done: z.boolean().optional(),
  limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
}).strict();

type TodoToolInput = z.infer<typeof todoInputSchema>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
`;

const invalidInput = (error: string, detail?: string) => ({
  error,
  ...(detail ? { detail } : {}),
});

const formatZodInputError = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Invalid input";

const getWorkspaceFromContext = (context: ToolExecutionContext) => {
  const workspace = typeof context.workspace === "string"
    ? context.workspace.trim()
    : "";

  if (!workspace) {
    return {
      error: "Workspace unavailable: todo tool requires context.workspace",
    } as const;
  }

  return { workspace } as const;
};

export const getTodoDbPath = (workspace: string) =>
  join(workspace, TODO_DB_DIR, TODO_DB_FILENAME);

const mapTodoRow = (row: TodoRow): TodoItem => ({
  id: row.id,
  title: row.title,
  note: row.note,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const normalizeTitle = (title: string) => {
  const normalized = title.trim();
  if (!normalized) {
    return { error: "Invalid title", detail: "title must be a non-empty string" } as const;
  }
  return { title: normalized } as const;
};

const openTodoDatabase = async (workspace: string) => {
  const dbPath = getTodoDbPath(workspace);
  await mkdir(join(workspace, TODO_DB_DIR), { recursive: true });

  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  return { db, dbPath };
};

const getTodoById = (db: Database, id: number): TodoRow | null =>
  db.query("SELECT id, title, note, status, created_at, updated_at, completed_at FROM todos WHERE id = ?")
    .get(id) as TodoRow | null;

const listTodos = (db: Database, status: "all" | TodoStatus, limit: number): TodoRow[] => {
  if (status === "open") {
    return db
      .query(
        "SELECT id, title, note, status, created_at, updated_at, completed_at FROM todos WHERE status = 'open' ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as TodoRow[];
  }

  if (status === "done") {
    return db
      .query(
        "SELECT id, title, note, status, created_at, updated_at, completed_at FROM todos WHERE status = 'done' ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as TodoRow[];
  }

  return db
    .query(
      "SELECT id, title, note, status, created_at, updated_at, completed_at FROM todos ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT ?",
    )
    .all(limit) as TodoRow[];
};

const executeList = (db: Database, input: unknown) => {
  const parsed = listActionSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput("Invalid list action input", formatZodInputError(parsed.error));
  }

  const status = parsed.data.status ?? "all";
  const limit = parsed.data.limit ?? DEFAULT_LIST_LIMIT;
  const rows = listTodos(db, status, limit);

  return {
    action: "list" as const,
    status,
    limit,
    count: rows.length,
    items: rows.map(mapTodoRow),
  };
};

const executeAdd = (db: Database, input: unknown) => {
  const parsed = addActionSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput("Invalid add action input", formatZodInputError(parsed.error));
  }

  const normalizedTitle = normalizeTitle(parsed.data.title);
  if ("error" in normalizedTitle) {
    return normalizedTitle;
  }

  const note = parsed.data.note ?? "";
  const insertResult = db
    .query("INSERT INTO todos (title, note) VALUES (?, ?)")
    .run(normalizedTitle.title, note);
  const rawId = insertResult.lastInsertRowid;
  const id = typeof rawId === "bigint" ? Number(rawId) : rawId;
  const row = getTodoById(db, id);

  return {
    action: "add" as const,
    success: true,
    item: row ? mapTodoRow(row) : null,
  };
};

const executeUpdate = (db: Database, input: unknown) => {
  const parsed = updateActionSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput("Invalid update action input", formatZodInputError(parsed.error));
  }

  const { id, title, note } = parsed.data;
  if (title === undefined && note === undefined) {
    return invalidInput("Invalid update action input", "At least one of title or note is required");
  }

  let normalizedTitle: string | undefined;
  if (title !== undefined) {
    const normalized = normalizeTitle(title);
    if ("error" in normalized) {
      return normalized;
    }
    normalizedTitle = normalized.title;
  }

  let updateResult: { changes: number };
  if (normalizedTitle !== undefined && note !== undefined) {
    updateResult = db
      .query(
        "UPDATE todos SET title = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(normalizedTitle, note, id);
  } else if (normalizedTitle !== undefined) {
    updateResult = db
      .query(
        "UPDATE todos SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(normalizedTitle, id);
  } else {
    updateResult = db
      .query(
        "UPDATE todos SET note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(note!, id);
  }

  if (updateResult.changes === 0) {
    return {
      error: "Todo item not found",
      id,
    };
  }

  const row = getTodoById(db, id);
  return {
    action: "update" as const,
    success: true,
    item: row ? mapTodoRow(row) : null,
  };
};

const executeSetDone = (db: Database, input: unknown) => {
  const parsed = setDoneActionSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput("Invalid set_done action input", formatZodInputError(parsed.error));
  }

  const { id } = parsed.data;
  const done = parsed.data.done ?? true;
  const updateResult = done
    ? db
      .query(
        "UPDATE todos SET status = 'done', completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(id)
    : db
      .query(
        "UPDATE todos SET status = 'open', completed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(id);

  if (updateResult.changes === 0) {
    return {
      error: "Todo item not found",
      id,
    };
  }

  const row = getTodoById(db, id);
  return {
    action: "set_done" as const,
    success: true,
    item: row ? mapTodoRow(row) : null,
  };
};

const executeRemove = (db: Database, input: unknown) => {
  const parsed = removeActionSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput("Invalid remove action input", formatZodInputError(parsed.error));
  }

  const { id } = parsed.data;
  const deleteResult = db.query("DELETE FROM todos WHERE id = ?").run(id);
  if (deleteResult.changes === 0) {
    return {
      error: "Todo item not found",
      id,
    };
  }

  return {
    action: "remove" as const,
    success: true,
    id,
  };
};

const executeClearDone = (db: Database, input: unknown) => {
  const parsed = clearDoneActionSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput("Invalid clear_done action input", formatZodInputError(parsed.error));
  }

  const deleteResult = db.query("DELETE FROM todos WHERE status = 'done'").run();

  return {
    action: "clear_done" as const,
    success: true,
    deletedCount: deleteResult.changes,
  };
};

const executeTodoAction = (db: Database, input: TodoToolInput) => {
  switch (input.action) {
    case "list":
      return executeList(db, input);
    case "add":
      return executeAdd(db, input);
    case "update":
      return executeUpdate(db, input);
    case "set_done":
      return executeSetDone(db, input);
    case "remove":
      return executeRemove(db, input);
    case "clear_done":
      return executeClearDone(db, input);
    default:
      return invalidInput("Unknown action");
  }
};

export const todoTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "Manage workspace TODO items in SQLite. Database path is fixed to {workspace}/.agent/todo.db.",
    inputSchema: todoInputSchema,
    execute: async (input: TodoToolInput) => {
      const workspaceResult = getWorkspaceFromContext(context);
      if ("error" in workspaceResult) {
        return workspaceResult;
      }

      const dbPath = getTodoDbPath(workspaceResult.workspace);
      if (!createPermissionPolicy(context).canUseTodo(dbPath)) {
        return {
          error: "Permission denied: todo path not allowed",
        };
      }

      let db: Database | null = null;
      try {
        const opened = await openTodoDatabase(workspaceResult.workspace);
        db = opened.db;
        return executeTodoAction(db, input);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "todo tool failed",
        };
      } finally {
        db?.close();
      }
    },
  });
