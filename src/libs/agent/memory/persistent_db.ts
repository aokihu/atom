import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PERSISTENT_MEMORY_DB_DIR,
  PERSISTENT_MEMORY_DB_FILENAME,
  type PersistentMemoryDatabaseRuntime,
} from "./persistent_types";

const SCHEMA_VERSION = 1;

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistent_memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL UNIQUE,
  source_tier TEXT NOT NULL CHECK (source_tier IN ('core')),
  memory_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
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
  recall_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pmem_updated_at ON persistent_memory_entries(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmem_recall_count ON persistent_memory_entries(recall_count DESC);
CREATE INDEX IF NOT EXISTS idx_pmem_confidence ON persistent_memory_entries(confidence DESC);
`;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS persistent_memory_fts USING fts5(
  entry_id UNINDEXED,
  summary,
  content,
  tags
);
`;

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

const initBaseSchema = (db: Database) => {
  db.exec(BASE_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
};

const tryInitFts = (db: Database): boolean => {
  try {
    db.exec(FTS_SCHEMA_SQL);
    // Rebuild FTS rows from canonical table to handle upgrades where FTS is added later.
    db.exec("DELETE FROM persistent_memory_fts");
    db.exec(`
      INSERT INTO persistent_memory_fts (rowid, entry_id, summary, content, tags)
      SELECT id, id, summary, content, tags_json
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
