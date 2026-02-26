import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export type TodoStatus = "open" | "done";
export type TodoEventType = "add" | "update" | "complete" | "reopen" | "remove" | "clear_done";
export type TodoEventActor = "agent" | "system";

type TodoRow = {
  id: number;
  title: string;
  note: string;
  status: TodoStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type TodoEventRow = {
  id: number;
  todo_id: number | null;
  event_type: TodoEventType;
  actor: TodoEventActor;
  tool_name: string | null;
  payload_json: string;
  created_at: string;
};

export type TodoItem = {
  id: number;
  title: string;
  note: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type TodoProgressContext = {
  summary: string;
  total: number;
  step: number;
};

export type TodoProgressItem = Pick<TodoItem, "id" | "status">;

export type TodoProgressState = {
  progress: TodoProgressContext;
  items: TodoProgressItem[];
};

export type TodoEventPayload = {
  v: 1;
  input: Record<string, unknown>;
  before: TodoItem | null;
  after: TodoItem | null;
  removedItems?: TodoItem[];
  progress: TodoProgressContext;
};

export type TodoEventRecord = {
  id: number;
  todoId: number | null;
  eventType: TodoEventType;
  actor: TodoEventActor;
  toolName: string | null;
  payloadJson: string;
  createdAt: string;
};

export const TODO_DB_DIR = ".agent";
export const TODO_DB_FILENAME = "todo.db";
export const DEFAULT_TODO_LIST_LIMIT = 100;
export const MAX_TODO_LIST_LIMIT = 500;

const TODO_DB_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

const TODO_ITEM_COLUMNS = "id, title, note, status, created_at, updated_at, completed_at";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS todo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status);

CREATE TABLE IF NOT EXISTS todo_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'system')),
  tool_name TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_todo_events_todo_id ON todo_events(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_events_event_type ON todo_events(event_type);
CREATE INDEX IF NOT EXISTS idx_todo_events_created_at ON todo_events(created_at);
`;

const mapTodoRow = (row: TodoRow): TodoItem => ({
  id: row.id,
  title: row.title,
  note: row.note,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const mapTodoEventRow = (row: TodoEventRow): TodoEventRecord => ({
  id: row.id,
  todoId: row.todo_id,
  eventType: row.event_type,
  actor: row.actor,
  toolName: row.tool_name,
  payloadJson: row.payload_json,
  createdAt: row.created_at,
});

const getTodoRowById = (db: Database, id: number): TodoRow | null =>
  db.query(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE id = ?`).get(id) as TodoRow | null;

const fileExists = async (filepath: string): Promise<boolean> => {
  try {
    await stat(filepath);
    return true;
  } catch {
    return false;
  }
};

const toSafeNonNegativeInt = (value: unknown): number => {
  const normalized = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 0;
  }
  return Math.trunc(normalized);
};

const computeTodoProgressFromItems = (items: TodoProgressItem[]): TodoProgressContext => {
  const total = items.length;
  if (total === 0) {
    return {
      summary: "暂无TODO",
      total: 0,
      step: 0,
    };
  }

  let done = 0;
  let firstOpenIndex = -1;
  let seenOpen = false;
  let hasSkippedCompletion = false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.status === "done") {
      done += 1;
      if (seenOpen) {
        hasSkippedCompletion = true;
      }
      continue;
    }

    seenOpen = true;
    if (firstOpenIndex < 0) {
      firstOpenIndex = index;
    }
  }

  if (done >= total || firstOpenIndex < 0) {
    return {
      summary: `已完成 ${done}/${total}`,
      total,
      step: total,
    };
  }

  const step = firstOpenIndex + 1;
  const skipSuffix = hasSkippedCompletion ? "，存在跳步" : "";
  return {
    summary: `进行中 ${done}/${total}（当前第${step}步${skipSuffix}）`,
    total,
    step,
  };
};

const getTodoProgressItems = (db: Database): TodoProgressItem[] => {
  const rows = db
    .query("SELECT id, status FROM todo_items ORDER BY id ASC")
    .all() as Array<{ id: number; status: TodoStatus }>;

  return rows.map((row) => ({ id: row.id, status: row.status }));
};

export const getTodoDbPath = (workspace: string) => join(workspace, TODO_DB_DIR, TODO_DB_FILENAME);

export const getTodoDbCleanupTargets = (workspace: string) => {
  const dbPath = getTodoDbPath(workspace);
  return TODO_DB_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`);
};

export const openTodoDatabase = async (workspace: string) => {
  await mkdir(join(workspace, TODO_DB_DIR), { recursive: true });
  const db = new Database(getTodoDbPath(workspace));
  db.exec(SCHEMA_SQL);
  return db;
};

export const listTodoItems = (
  db: Database,
  args?: {
    status?: "all" | TodoStatus;
    limit?: number;
  },
): TodoItem[] => {
  const status = args?.status ?? "all";
  const limit = args?.limit ?? DEFAULT_TODO_LIST_LIMIT;

  let rows: TodoRow[];
  if (status === "open") {
    rows = db
      .query(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE status = 'open' ORDER BY id ASC LIMIT ?`)
      .all(limit) as TodoRow[];
  } else if (status === "done") {
    rows = db
      .query(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE status = 'done' ORDER BY id ASC LIMIT ?`)
      .all(limit) as TodoRow[];
  } else {
    rows = db
      .query(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items ORDER BY id ASC LIMIT ?`)
      .all(limit) as TodoRow[];
  }

  return rows.map(mapTodoRow);
};

export const listAllTodoItems = (db: Database): TodoItem[] =>
  (db
    .query(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items ORDER BY id ASC`)
    .all() as TodoRow[]).map(mapTodoRow);

export const listTodoEvents = (db: Database): TodoEventRecord[] =>
  (db
    .query(
      "SELECT id, todo_id, event_type, actor, tool_name, payload_json, created_at FROM todo_events ORDER BY id ASC",
    )
    .all() as TodoEventRow[]).map(mapTodoEventRow);

export const getTodoItemById = (db: Database, id: number): TodoItem | null => {
  const row = getTodoRowById(db, id);
  return row ? mapTodoRow(row) : null;
};

export const addTodoItem = (
  db: Database,
  args: { title: string; note?: string },
): TodoItem | null => {
  const note = args.note ?? "";
  const insertResult = db
    .query("INSERT INTO todo_items (title, note) VALUES (?, ?)")
    .run(args.title, note);
  const rawId = insertResult.lastInsertRowid;
  const id = typeof rawId === "bigint" ? Number(rawId) : rawId;
  return getTodoItemById(db, id);
};

export const updateTodoItem = (
  db: Database,
  args: { id: number; title?: string; note?: string },
): TodoItem | null => {
  const { id, title, note } = args;

  let updateResult: { changes: number };
  if (title !== undefined && note !== undefined) {
    updateResult = db
      .query(
        "UPDATE todo_items SET title = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(title, note, id);
  } else if (title !== undefined) {
    updateResult = db
      .query(
        "UPDATE todo_items SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(title, id);
  } else if (note !== undefined) {
    updateResult = db
      .query(
        "UPDATE todo_items SET note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(note, id);
  } else {
    return getTodoItemById(db, id);
  }

  if (updateResult.changes === 0) {
    return null;
  }

  return getTodoItemById(db, id);
};

export const setTodoItemDone = (
  db: Database,
  args: { id: number; done: boolean },
): TodoItem | null => {
  const updateResult = args.done
    ? db
      .query(
        "UPDATE todo_items SET status = 'done', completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(args.id)
    : db
      .query(
        "UPDATE todo_items SET status = 'open', completed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(args.id);

  if (updateResult.changes === 0) {
    return null;
  }

  return getTodoItemById(db, args.id);
};

export const removeTodoItem = (db: Database, id: number): { removed: boolean; item: TodoItem | null } => {
  const existing = getTodoItemById(db, id);
  if (!existing) {
    return { removed: false, item: null };
  }

  const result = db.query("DELETE FROM todo_items WHERE id = ?").run(id);
  return { removed: result.changes > 0, item: existing };
};

export const clearDoneTodoItems = (
  db: Database,
): { deletedCount: number; removedItems: TodoItem[] } => {
  const removedItems = (db
    .query(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE status = 'done' ORDER BY id ASC`)
    .all() as TodoRow[]).map(mapTodoRow);

  const result = db.query("DELETE FROM todo_items WHERE status = 'done'").run();
  return { deletedCount: result.changes, removedItems };
};

export const appendTodoEvent = (
  db: Database,
  args: {
    todoId?: number | null;
    eventType: TodoEventType;
    actor: TodoEventActor;
    toolName?: string | null;
    payload: TodoEventPayload;
  },
): TodoEventRecord => {
  const payloadJson = JSON.stringify(args.payload);
  const insertResult = db
    .query(
      "INSERT INTO todo_events (todo_id, event_type, actor, tool_name, payload_json) VALUES (?, ?, ?, ?, ?)",
    )
    .run(args.todoId ?? null, args.eventType, args.actor, args.toolName ?? null, payloadJson);

  const rawId = insertResult.lastInsertRowid;
  const id = typeof rawId === "bigint" ? Number(rawId) : rawId;
  const row = db.query(
    "SELECT id, todo_id, event_type, actor, tool_name, payload_json, created_at FROM todo_events WHERE id = ?",
  ).get(id) as TodoEventRow | null;

  if (!row) {
    throw new Error("todo event insert failed: row not found");
  }

  return mapTodoEventRow(row);
};

export const getTodoProgressState = (db: Database): TodoProgressState => {
  const items = getTodoProgressItems(db);
  return {
    items,
    progress: computeTodoProgressFromItems(items),
  };
};

export const getTodoProgressContext = (db: Database): TodoProgressContext =>
  getTodoProgressState(db).progress;

export const readTodoProgressStateForWorkspace = (workspace: string): TodoProgressState => {
  const dbPath = getTodoDbPath(workspace);
  if (!existsSync(dbPath)) {
    return {
      items: [],
      progress: {
        summary: "暂无TODO",
        total: 0,
        step: 0,
      },
    };
  }

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return getTodoProgressState(db);
  } finally {
    db?.close();
  }
};

export const readTodoProgressContextForWorkspace = (workspace: string): TodoProgressContext =>
  readTodoProgressStateForWorkspace(workspace).progress;

type CleanupDeps = {
  exists?: (filepath: string) => Promise<boolean>;
  remove?: (filepath: string) => Promise<void>;
};

export const cleanupTodoDbOnStartup = async (
  args: { workspace: string },
  deps: CleanupDeps = {},
): Promise<{ skipped: boolean; removed: number; removedFiles: string[] }> => {
  const existsFn = deps.exists ?? fileExists;
  const removeFn = deps.remove ?? (async (filepath: string) => {
    await rm(filepath, { force: true });
  });

  const targets = getTodoDbCleanupTargets(args.workspace);
  const existingTargets: string[] = [];
  for (const target of targets) {
    if (await existsFn(target)) {
      existingTargets.push(target);
    }
  }

  if (existingTargets.length === 0) {
    return {
      skipped: true,
      removed: 0,
      removedFiles: [],
    };
  }

  const removedFiles: string[] = [];
  for (const target of existingTargets) {
    try {
      await removeFn(target);
      removedFiles.push(target);
    } catch (error) {
      throw new Error(
        `TODO startup cleanup failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    skipped: false,
    removed: removedFiles.length,
    removedFiles,
  };
};

export const __todoStoreInternals = {
  computeTodoProgressFromItems,
  toSafeNonNegativeInt,
};
