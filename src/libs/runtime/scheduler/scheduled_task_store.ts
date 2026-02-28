import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScheduledTaskRecord, ScheduleTrigger } from "../../../types/schedule";

export const SCHEDULE_DB_DIR = ".agent";
export const SCHEDULE_DB_FILENAME = "schedule.db";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  schedule_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  task_input TEXT NOT NULL,
  task_type TEXT NOT NULL,
  priority INTEGER NOT NULL,
  trigger_json TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run_at
  ON scheduled_tasks(next_run_at ASC);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_dedupe_key
  ON scheduled_tasks(dedupe_key);
`;

type ScheduledTaskRow = {
  schedule_id: string;
  dedupe_key: string;
  task_input: string;
  task_type: string;
  priority: number;
  trigger_json: string;
  next_run_at: number;
  created_at: number;
  updated_at: number;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseTrigger = (raw: string): ScheduleTrigger | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isObjectRecord(parsed) || typeof parsed.mode !== "string") {
    return null;
  }

  if (parsed.mode === "delay") {
    if (typeof parsed.delaySeconds !== "number") return null;
    return {
      mode: "delay",
      delaySeconds: parsed.delaySeconds,
    };
  }

  if (parsed.mode === "at") {
    if (typeof parsed.runAt !== "string") return null;
    return {
      mode: "at",
      runAt: parsed.runAt,
    };
  }

  if (parsed.mode === "cron") {
    if (typeof parsed.cron !== "string" || parsed.timezone !== "UTC") return null;
    return {
      mode: "cron",
      cron: parsed.cron,
      timezone: "UTC",
    };
  }

  return null;
};

const toRecord = (row: ScheduledTaskRow): ScheduledTaskRecord | null => {
  const trigger = parseTrigger(row.trigger_json);
  if (!trigger) return null;
  return {
    scheduleId: row.schedule_id,
    dedupeKey: row.dedupe_key,
    taskInput: row.task_input,
    taskType: row.task_type,
    priority: row.priority as 0 | 1 | 2 | 3 | 4,
    trigger,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const getScheduleDbPath = (workspace: string) =>
  join(workspace, SCHEDULE_DB_DIR, SCHEDULE_DB_FILENAME);

export type ScheduledTaskPersistence = {
  listRecords: () => ScheduledTaskRecord[];
  upsertRecord: (record: ScheduledTaskRecord) => void;
  deleteRecord: (scheduleId: string) => void;
  dispose: () => void;
};

export class SqliteScheduledTaskStore implements ScheduledTaskPersistence {
  private readonly db: Database;

  constructor(
    workspace: string,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {
    const dbPath = getScheduleDbPath(workspace);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA_SQL);
  }

  listRecords(): ScheduledTaskRecord[] {
    const rows = this.db
      .query(
        `SELECT schedule_id, dedupe_key, task_input, task_type, priority, trigger_json, next_run_at, created_at, updated_at
         FROM scheduled_tasks
         ORDER BY next_run_at ASC`,
      )
      .all() as ScheduledTaskRow[];

    const records: ScheduledTaskRecord[] = [];
    for (const row of rows) {
      const record = toRecord(row);
      if (!record) {
        this.logger.warn(
          `[scheduler] skipped invalid persisted schedule row: schedule_id=${String(row.schedule_id ?? "")}`,
        );
        continue;
      }
      records.push(record);
    }
    return records;
  }

  upsertRecord(record: ScheduledTaskRecord): void {
    this.db
      .query(
        `INSERT INTO scheduled_tasks (
          schedule_id, dedupe_key, task_input, task_type, priority, trigger_json, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(schedule_id) DO UPDATE SET
          dedupe_key = excluded.dedupe_key,
          task_input = excluded.task_input,
          task_type = excluded.task_type,
          priority = excluded.priority,
          trigger_json = excluded.trigger_json,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.scheduleId,
        record.dedupeKey,
        record.taskInput,
        record.taskType,
        record.priority,
        JSON.stringify(record.trigger),
        record.nextRunAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  deleteRecord(scheduleId: string): void {
    this.db.query("DELETE FROM scheduled_tasks WHERE schedule_id = ?").run(scheduleId);
  }

  dispose(): void {
    try {
      this.db.close(false);
    } catch {
      // best-effort close
    }
  }
}
