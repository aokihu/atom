import { createHash } from "node:crypto";
import type { ContextMemoryBlock, PersistentMemorySearchMode } from "../../../types/agent";
import type {
  PersistentMemoryBulkReadResult,
  PersistentMemoryEntry,
  PersistentMemoryEntryRow,
  PersistentMemorySearchHit,
  PersistentMemorySearchResult,
  PersistentMemoryUpsertStats,
  UpsertCoreBlocksArgs,
} from "./persistent_types";
import type { PersistentMemoryDatabaseHandle } from "./persistent_db";

const normalizeFinite = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const parseTags = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
};

const rowToEntry = (row: PersistentMemoryEntryRow): PersistentMemoryEntry => ({
  id: normalizeFinite(row.id),
  blockId: row.block_id,
  sourceTier: "core",
  memoryType: row.memory_type,
  summary: row.summary,
  content: row.content,
  tags: parseTags(row.tags_json),
  confidence: clamp01(normalizeFinite(row.confidence)),
  decay: clamp01(normalizeFinite(row.decay)),
  status: row.status,
  contentHash: row.content_hash,
  firstSeenRound: Math.max(1, Math.trunc(normalizeFinite(row.first_seen_round, 1))),
  lastSeenRound: Math.max(1, Math.trunc(normalizeFinite(row.last_seen_round, 1))),
  sourceTaskId: row.source_task_id,
  createdAt: Math.trunc(normalizeFinite(row.created_at)),
  updatedAt: Math.trunc(normalizeFinite(row.updated_at)),
  lastRecalledAt:
    row.last_recalled_at == null ? null : Math.trunc(normalizeFinite(row.last_recalled_at)),
  recallCount: Math.max(0, Math.trunc(normalizeFinite(row.recall_count))),
});

const normalizeSearchTokens = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);

const buildFtsQuery = (tokens: string[]): string | null => {
  if (tokens.length === 0) return null;
  const unique = [...new Set(tokens)];
  const escaped = unique.map((token) => `"${token.replaceAll('"', '""')}"`);
  return escaped.join(" OR ");
};

const escapeLike = (value: string) =>
  value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");

const countTextMatches = (haystack: string, tokens: string[]): number => {
  const text = haystack.toLowerCase();
  let count = 0;
  for (const token of tokens) {
    if (text.includes(token)) count += 1;
  }
  return count;
};

const computeLikeTextScore = (entry: PersistentMemoryEntry, tokens: string[]): number => {
  if (tokens.length === 0) return 0;
  const summaryMatches = countTextMatches(entry.summary, tokens);
  const contentMatches = countTextMatches(entry.content, tokens);
  const tagMatches = countTextMatches(entry.tags.join(" "), tokens);

  const weighted = summaryMatches * 1.6 + contentMatches * 1 + tagMatches * 1.2;
  const maxWeighted = tokens.length * 3.8;
  return clamp01(maxWeighted <= 0 ? 0 : weighted / maxWeighted);
};

const computeFtsTextScore = (rank: number): number => {
  // FTS5 bm25 tends to be lower-is-better (often small or negative). Convert to a stable [0, 1] score.
  const magnitude = Math.abs(rank);
  return clamp01(1 / (1 + magnitude));
};

const computeRecencyScore = (updatedAt: number, now: number): number => {
  const ageMs = Math.max(0, now - updatedAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return clamp01(1 / (1 + ageDays / 30));
};

const computeRecallScore = (recallCount: number): number => clamp01(recallCount / 20);

const computeFinalScore = (
  textScore: number,
  confidenceScore: number,
  recencyScore: number,
  recallScore: number,
): number =>
  0.55 * textScore + 0.25 * confidenceScore + 0.15 * recencyScore + 0.05 * recallScore;

const toContentHash = (content: string) => createHash("sha256").update(content).digest("hex");

export const derivePersistentMemorySummary = (content: string): string => {
  const normalized = content.trim();
  if (!normalized) return "";

  const firstLine = normalized.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? normalized;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}` : firstLine;
};

type SearchRowWithRank = PersistentMemoryEntryRow & {
  rank?: number | null;
};

type SearchCountRow = {
  total: number;
};

export class PersistentMemoryStore {
  constructor(private readonly handle: PersistentMemoryDatabaseHandle) {}

  get dbPath() {
    return this.handle.runtime.dbPath;
  }

  get ftsEnabled() {
    return this.handle.runtime.ftsEnabled;
  }

  private syncFtsRow(entry: {
    id: number;
    summary: string;
    content: string;
    tagsJson: string;
  }) {
    if (!this.ftsEnabled) return;

    this.handle.db.query("DELETE FROM persistent_memory_fts WHERE rowid = ?").run(entry.id);
    this.handle.db
      .query(
        "INSERT INTO persistent_memory_fts (rowid, entry_id, summary, content, tags) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.id, entry.summary, entry.content, entry.tagsJson);
  }

  private getEntryRowByBlockId(blockId: string): PersistentMemoryEntryRow | null {
    return this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, tags_json, confidence, decay,
                status, content_hash, first_seen_round, last_seen_round, source_task_id, created_at,
                updated_at, last_recalled_at, recall_count
           FROM persistent_memory_entries
          WHERE block_id = ?`,
      )
      .get(blockId) as PersistentMemoryEntryRow | null;
  }

  async upsertCoreBlocks(args: UpsertCoreBlocksArgs): Promise<PersistentMemoryUpsertStats> {
    const stats: PersistentMemoryUpsertStats = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    };

    const now = Date.now();

    for (const block of args.blocks) {
      const blockId = typeof block.id === "string" ? block.id.trim() : "";
      const content = typeof block.content === "string" ? block.content.trim() : "";
      if (!blockId || !content) {
        stats.skipped += 1;
        continue;
      }

      const memoryType = typeof block.type === "string" && block.type.trim() ? block.type.trim() : "memory";
      const tags = Array.isArray(block.tags)
        ? block.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const tagsJson = JSON.stringify(tags);
      const confidence = clamp01(typeof block.confidence === "number" ? block.confidence : 0.5);
      const decay = clamp01(typeof block.decay === "number" ? block.decay : 0);
      const round = Math.max(1, Math.trunc(typeof block.round === "number" ? block.round : 1));
      const status = typeof block.status === "string" ? block.status : null;
      const summary = derivePersistentMemorySummary(content);
      const contentHash = toContentHash(content);
      const sourceTaskId =
        (typeof block.task_id === "string" && block.task_id.trim() ? block.task_id : null) ??
        (args.sourceTaskId ?? null);

      const existing = this.getEntryRowByBlockId(blockId);
      if (!existing) {
        const insertResult = this.handle.db
          .query(
            `INSERT INTO persistent_memory_entries (
               block_id, source_tier, memory_type, summary, content, tags_json, confidence, decay, status,
               content_hash, first_seen_round, last_seen_round, source_task_id, created_at, updated_at
             ) VALUES (?, 'core', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            blockId,
            memoryType,
            summary,
            content,
            tagsJson,
            confidence,
            decay,
            status,
            contentHash,
            round,
            round,
            sourceTaskId,
            now,
            now,
          );

        const insertedIdRaw = insertResult.lastInsertRowid;
        const insertedId = normalizeFinite(insertedIdRaw);
        if (insertedId > 0) {
          this.syncFtsRow({ id: insertedId, summary, content, tagsJson });
        }
        stats.inserted += 1;
        continue;
      }

      if (existing.content_hash === contentHash) {
        this.handle.db
          .query(
            `UPDATE persistent_memory_entries
                SET last_seen_round = ?,
                    source_task_id = ?
              WHERE id = ?`,
          )
          .run(round, sourceTaskId, existing.id);
        stats.unchanged += 1;
        continue;
      }

      this.handle.db
        .query(
          `UPDATE persistent_memory_entries
              SET memory_type = ?,
                  summary = ?,
                  content = ?,
                  tags_json = ?,
                  confidence = ?,
                  decay = ?,
                  status = ?,
                  content_hash = ?,
                  last_seen_round = ?,
                  source_task_id = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          memoryType,
          summary,
          content,
          tagsJson,
          confidence,
          decay,
          status,
          contentHash,
          round,
          sourceTaskId,
          now,
          existing.id,
        );
      this.syncFtsRow({ id: normalizeFinite(existing.id), summary, content, tagsJson });
      stats.updated += 1;
    }

    return stats;
  }

  async searchRelevant(args: {
    query: string;
    limit: number;
    mode: PersistentMemorySearchMode;
    excludeBlockIds?: Iterable<string>;
  }): Promise<PersistentMemorySearchResult> {
    const tokens = normalizeSearchTokens(args.query);
    if (tokens.length === 0) {
      return { hits: [], modeUsed: this.ftsEnabled && args.mode !== "like" ? "fts" : "like" };
    }

    const exclude = new Set<string>();
    for (const item of args.excludeBlockIds ?? []) {
      if (typeof item === "string" && item.trim()) exclude.add(item.trim());
    }

    const limit = Math.max(1, Math.min(12, Math.trunc(args.limit)));
    const candidates = this.ftsEnabled && args.mode !== "like"
      ? this.searchWithFts(tokens, limit, exclude)
      : this.searchWithLike(tokens, limit, exclude);

    return candidates;
  }

  async bulkReadByQuery(
    query: string,
    limit = 20,
    offset = 0,
  ): Promise<PersistentMemoryBulkReadResult> {
    const tokens = normalizeSearchTokens(query);
    const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const normalizedOffset = Math.max(0, Math.trunc(offset));
    const preferredMode: "fts" | "like" = this.ftsEnabled ? "fts" : "like";

    if (tokens.length === 0) {
      return {
        entries: [],
        pagination: {
          total: 0,
          limit: normalizedLimit,
          offset: normalizedOffset,
        },
        modeUsed: preferredMode,
      };
    }

    if (this.ftsEnabled) {
      const viaFts = this.bulkReadWithFts(tokens, normalizedLimit, normalizedOffset);
      if (viaFts) {
        return viaFts;
      }
    }

    return this.bulkReadWithLike(tokens, normalizedLimit, normalizedOffset);
  }

  private searchWithFts(
    tokens: string[],
    limit: number,
    exclude: Set<string>,
  ): PersistentMemorySearchResult {
    const ftsQuery = buildFtsQuery(tokens);
    if (!ftsQuery) {
      return { hits: [], modeUsed: "fts" };
    }

    try {
      const rawRows = this.handle.db
        .query(
          `SELECT e.id, e.block_id, e.source_tier, e.memory_type, e.summary, e.content, e.tags_json, e.confidence,
                  e.decay, e.status, e.content_hash, e.first_seen_round, e.last_seen_round, e.source_task_id,
                  e.created_at, e.updated_at, e.last_recalled_at, e.recall_count,
                  bm25(persistent_memory_fts) AS rank
             FROM persistent_memory_fts
             JOIN persistent_memory_entries e ON e.id = persistent_memory_fts.rowid
            WHERE persistent_memory_fts MATCH ?
            LIMIT ?`,
        )
        .all(ftsQuery, limit * 6) as SearchRowWithRank[];

      const now = Date.now();
      const hits: PersistentMemorySearchHit[] = [];
      for (const row of rawRows) {
        const entry = rowToEntry(row);
        if (exclude.has(entry.blockId)) continue;
        const textScore = computeFtsTextScore(normalizeFinite(row.rank, 0));
        const confidenceScore = entry.confidence;
        const recencyScore = computeRecencyScore(entry.updatedAt, now);
        const recallScore = computeRecallScore(entry.recallCount);
        const finalScore = computeFinalScore(textScore, confidenceScore, recencyScore, recallScore);
        hits.push({ entry, textScore, confidenceScore, recencyScore, recallScore, finalScore });
      }

      hits.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
        return b.entry.updatedAt - a.entry.updatedAt;
      });

      return { hits: hits.slice(0, limit), modeUsed: "fts" };
    } catch {
      // FTS query parsing can fail on some token combinations; fallback to LIKE.
      return this.searchWithLike(tokens, limit, exclude);
    }
  }

  private searchWithLike(
    tokens: string[],
    limit: number,
    exclude: Set<string>,
  ): PersistentMemorySearchResult {
    const likeTerms = tokens.map((token) => `%${escapeLike(token)}%`);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    for (const term of likeTerms) {
      clauses.push("(summary LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!')");
      params.push(term, term, term);
    }

    const whereSql = clauses.length > 0 ? clauses.join(" OR ") : "1 = 1";
    const rawRows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, tags_json, confidence, decay,
                status, content_hash, first_seen_round, last_seen_round, source_task_id, created_at,
                updated_at, last_recalled_at, recall_count
           FROM persistent_memory_entries
          WHERE ${whereSql}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...params, limit * 10) as PersistentMemoryEntryRow[];

    const now = Date.now();
    const hits: PersistentMemorySearchHit[] = [];
    for (const row of rawRows) {
      const entry = rowToEntry(row);
      if (exclude.has(entry.blockId)) continue;
      const textScore = computeLikeTextScore(entry, tokens);
      if (textScore <= 0) continue;
      const confidenceScore = entry.confidence;
      const recencyScore = computeRecencyScore(entry.updatedAt, now);
      const recallScore = computeRecallScore(entry.recallCount);
      const finalScore = computeFinalScore(textScore, confidenceScore, recencyScore, recallScore);
      hits.push({ entry, textScore, confidenceScore, recencyScore, recallScore, finalScore });
    }

    hits.sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
      return b.entry.updatedAt - a.entry.updatedAt;
    });

    return { hits: hits.slice(0, limit), modeUsed: "like" };
  }

  private bulkReadWithFts(
    tokens: string[],
    limit: number,
    offset: number,
  ): PersistentMemoryBulkReadResult | null {
    const ftsQuery = buildFtsQuery(tokens);
    if (!ftsQuery) {
      return {
        entries: [],
        pagination: { total: 0, limit, offset },
        modeUsed: "fts",
      };
    }

    try {
      const countRow = this.handle.db
        .query(
          `SELECT COUNT(1) AS total
             FROM persistent_memory_fts
            WHERE persistent_memory_fts MATCH ?`,
        )
        .get(ftsQuery) as SearchCountRow | null;

      const rows = this.handle.db
        .query(
          `SELECT e.id, e.block_id, e.source_tier, e.memory_type, e.summary, e.content, e.tags_json, e.confidence,
                  e.decay, e.status, e.content_hash, e.first_seen_round, e.last_seen_round, e.source_task_id,
                  e.created_at, e.updated_at, e.last_recalled_at, e.recall_count,
                  bm25(persistent_memory_fts) AS rank
             FROM persistent_memory_fts
             JOIN persistent_memory_entries e ON e.id = persistent_memory_fts.rowid
            WHERE persistent_memory_fts MATCH ?
            ORDER BY rank ASC, e.updated_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(ftsQuery, limit, offset) as SearchRowWithRank[];

      return {
        entries: rows.map((row) => rowToEntry(row)),
        pagination: {
          total: Math.max(0, Math.trunc(normalizeFinite(countRow?.total, 0))),
          limit,
          offset,
        },
        modeUsed: "fts",
      };
    } catch {
      return null;
    }
  }

  private bulkReadWithLike(
    tokens: string[],
    limit: number,
    offset: number,
  ): PersistentMemoryBulkReadResult {
    const likeTerms = tokens.map((token) => `%${escapeLike(token)}%`);
    const clauses: string[] = [];
    const params: string[] = [];
    for (const term of likeTerms) {
      clauses.push("(summary LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!')");
      params.push(term, term, term);
    }

    const whereSql = clauses.length > 0 ? clauses.join(" OR ") : "1 = 1";
    const countRow = this.handle.db
      .query(
        `SELECT COUNT(1) AS total
           FROM persistent_memory_entries
          WHERE ${whereSql}`,
      )
      .get(...params) as SearchCountRow | null;

    const rows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, tags_json, confidence, decay,
                status, content_hash, first_seen_round, last_seen_round, source_task_id, created_at,
                updated_at, last_recalled_at, recall_count
           FROM persistent_memory_entries
          WHERE ${whereSql}
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as PersistentMemoryEntryRow[];

    return {
      entries: rows.map((row) => rowToEntry(row)),
      pagination: {
        total: Math.max(0, Math.trunc(normalizeFinite(countRow?.total, 0))),
        limit,
        offset,
      },
      modeUsed: "like",
    };
  }

  async markRecalled(entryIds: number[]): Promise<void> {
    if (entryIds.length === 0) return;
    const now = Date.now();
    for (const entryId of entryIds) {
      const id = Math.trunc(entryId);
      if (!Number.isFinite(id) || id <= 0) continue;
      this.handle.db
        .query(
          `UPDATE persistent_memory_entries
              SET recall_count = recall_count + 1,
                  last_recalled_at = ?
            WHERE id = ?`,
        )
        .run(now, id);
    }
  }

  async listAllEntries(): Promise<PersistentMemoryEntry[]> {
    const rows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, tags_json, confidence, decay,
                status, content_hash, first_seen_round, last_seen_round, source_task_id, created_at,
                updated_at, last_recalled_at, recall_count
           FROM persistent_memory_entries
          ORDER BY id ASC`,
      )
      .all() as PersistentMemoryEntryRow[];

    return rows.map(rowToEntry);
  }
}
