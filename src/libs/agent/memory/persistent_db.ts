import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PERSISTENT_MEMORY_DB_DIR,
  PERSISTENT_MEMORY_DB_FILENAME,
  type PersistentMemoryDatabaseRuntime,
} from "./persistent_types";

const SCHEMA_VERSION = 3;

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistent_memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL UNIQUE,
  source_tier TEXT NOT NULL CHECK (source_tier IN ('core', 'longterm')) DEFAULT 'core',
  memory_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  content_state TEXT NOT NULL CHECK (content_state IN ('active', 'tag_ref')) DEFAULT 'active',
  tag_id TEXT,
  tag_summary TEXT,
  tags_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  decay REAL NOT NULL,
  status TEXT,
  content_hash TEXT NOT NULL,
  first_seen_round INTEGER NOT NULL,
  last_seen_round INTEGER NOT NULL,
  source_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER,
  rehydrated_at INTEGER,
  recall_count INTEGER NOT NULL DEFAULT 0,
  feedback_positive INTEGER NOT NULL DEFAULT 0,
  feedback_negative INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pmem_updated_at ON persistent_memory_entries(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmem_recall_count ON persistent_memory_entries(recall_count DESC);
CREATE INDEX IF NOT EXISTS idx_pmem_confidence ON persistent_memory_entries(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_pmem_source_tier ON persistent_memory_entries(source_tier);
CREATE INDEX IF NOT EXISTS idx_pmem_content_state ON persistent_memory_entries(content_state);
CREATE INDEX IF NOT EXISTS idx_pmem_tag_id ON persistent_memory_entries(tag_id);
`;

const TAG_PAYLOAD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistent_memory_tag_payloads (
  tag_id TEXT PRIMARY KEY,
  full_content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmem_tag_payload_updated_at ON persistent_memory_tag_payloads(updated_at DESC);
`;

const EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistent_memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER,
  block_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmem_events_created_at ON persistent_memory_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmem_events_entry_id ON persistent_memory_events(entry_id);
`;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS persistent_memory_fts USING fts5(
  entry_id UNINDEXED,
  summary,
  content,
  tags,
  tag_summary
);
`;

const REQUIRED_COLUMNS: Array<{ name: string; sql: string }> = [
  {
    name: "source_tier",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN source_tier TEXT NOT NULL DEFAULT 'core'",
  },
  {
    name: "content_state",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN content_state TEXT NOT NULL DEFAULT 'active'",
  },
  {
    name: "tag_id",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN tag_id TEXT",
  },
  {
    name: "tag_summary",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN tag_summary TEXT",
  },
  {
    name: "rehydrated_at",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN rehydrated_at INTEGER",
  },
  {
    name: "feedback_positive",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN feedback_positive INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "feedback_negative",
    sql: "ALTER TABLE persistent_memory_entries ADD COLUMN feedback_negative INTEGER NOT NULL DEFAULT 0",
  },
];

export type PersistentMemoryDatabaseHandle = {
  db: Database;
  runtime: PersistentMemoryDatabaseRuntime;
};

export const getPersistentMemoryDbPath = (workspace: string) =>
  join(workspace, PERSISTENT_MEMORY_DB_DIR, PERSISTENT_MEMORY_DB_FILENAME);

const ensurePersistentMemoryDbDirectory = (dbPath: string) => {
  mkdirSync(dirname(dbPath), { recursive: true });
};

const applyPragmas = (db: Database) => {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
};

const getExistingColumns = (db: Database): Set<string> => {
  const rows = db.query("PRAGMA table_info(persistent_memory_entries)").all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
};

const ensureRequiredColumns = (db: Database) => {
  const columns = getExistingColumns(db);
  for (const column of REQUIRED_COLUMNS) {
    if (columns.has(column.name)) continue;
    db.exec(column.sql);
  }
};

const normalizeRowsForV3 = (db: Database) => {
  db.exec(`
    UPDATE persistent_memory_entries
       SET source_tier = COALESCE(NULLIF(source_tier, ''), 'core')
     WHERE source_tier IS NULL OR source_tier = ''
  `);
  db.exec(`
    UPDATE persistent_memory_entries
       SET source_tier = 'core'
     WHERE source_tier NOT IN ('core', 'longterm')
  `);
  db.exec(`
    UPDATE persistent_memory_entries
       SET content_state = COALESCE(NULLIF(content_state, ''), 'active')
     WHERE content_state IS NULL OR content_state = ''
  `);
  db.exec(`
    UPDATE persistent_memory_entries
       SET content_state = 'active'
     WHERE content_state NOT IN ('active', 'tag_ref')
  `);
  db.exec(`
    UPDATE persistent_memory_entries
       SET feedback_positive = COALESCE(feedback_positive, 0),
           feedback_negative = COALESCE(feedback_negative, 0)
  `);
};

const initBaseSchema = (db: Database) => {
  db.exec(BASE_SCHEMA_SQL);
  ensureRequiredColumns(db);
  db.exec(TAG_PAYLOAD_SCHEMA_SQL);
  db.exec(EVENTS_SCHEMA_SQL);
  normalizeRowsForV3(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
};

const tryInitFts = (db: Database): boolean => {
  try {
    db.exec(FTS_SCHEMA_SQL);
    db.exec("DELETE FROM persistent_memory_fts");
    db.exec(`
      INSERT INTO persistent_memory_fts (rowid, entry_id, summary, content, tags, tag_summary)
      SELECT id, id, summary, content, tags_json, COALESCE(tag_summary, '')
      FROM persistent_memory_entries
    `);
    return true;
  } catch {
    return false;
  }
};

export const openPersistentMemoryDatabase = (
  workspace: string,
): PersistentMemoryDatabaseHandle => {
  const dbPath = getPersistentMemoryDbPath(workspace);
  ensurePersistentMemoryDbDirectory(dbPath);
  const db = new Database(dbPath);
  let ok = false;

  try {
    applyPragmas(db);
    initBaseSchema(db);
    const ftsEnabled = tryInitFts(db);
    ok = true;

    return {
      db,
      runtime: {
        dbPath,
        ftsEnabled,
      },
    };
  } finally {
    if (!ok) {
      try {
        db.close(false);
      } catch {
        // best-effort cleanup on init failure
      }
    }
  }
};

export const closePersistentMemoryDatabase = async (
  handle: PersistentMemoryDatabaseHandle | undefined,
): Promise<void> => {
  if (!handle) return;
  try {
    handle.db.close(false);
  } catch {
    // best-effort shutdown
  }
};
