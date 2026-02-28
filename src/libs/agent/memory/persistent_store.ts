import { createHash } from "node:crypto";
import type { ContextMemoryBlock, PersistentMemorySearchMode } from "../../../types/agent";
import type {
  PersistentMemoryBulkReadResult,
  PersistentMemoryEntry,
  PersistentMemoryEntryRow,
  PersistentMemorySearchHit,
  PersistentMemorySearchResult,
  PersistentMemoryTagPayloadRow,
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

const normalizeTagList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
    if (tags.length >= 32) break;
  }
  return tags;
};

const rowToEntry = (row: PersistentMemoryEntryRow): PersistentMemoryEntry => ({
  id: normalizeFinite(row.id),
  blockId: row.block_id,
  sourceTier: row.source_tier,
  memoryType: row.memory_type,
  summary: row.summary,
  content: row.content,
  contentState: row.content_state,
  tagId: row.tag_id,
  tagSummary: row.tag_summary,
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
  rehydratedAt:
    row.rehydrated_at == null ? null : Math.trunc(normalizeFinite(row.rehydrated_at)),
  recallCount: Math.max(0, Math.trunc(normalizeFinite(row.recall_count))),
  feedbackPositive: Math.max(0, Math.trunc(normalizeFinite(row.feedback_positive))),
  feedbackNegative: Math.max(0, Math.trunc(normalizeFinite(row.feedback_negative))),
});

const normalizeSearchTokens = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 16);

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
  const tagSummaryMatches = countTextMatches(entry.tagSummary ?? "", tokens);

  const weighted = summaryMatches * 1.5 + contentMatches * 1 + tagMatches * 1.1 + tagSummaryMatches * 1.3;
  const maxWeighted = tokens.length * 4.9;
  return clamp01(maxWeighted <= 0 ? 0 : weighted / maxWeighted);
};

const computeFtsTextScore = (rank: number): number => {
  const magnitude = Math.abs(rank);
  return clamp01(1 / (1 + magnitude));
};

const computeRecencyScore = (updatedAt: number, now: number): number => {
  const ageMs = Math.max(0, now - updatedAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return clamp01(1 / (1 + ageDays / 30));
};

const computeRecallScore = (recallCount: number): number => clamp01(recallCount / 20);

const computeFeedbackScore = (entry: PersistentMemoryEntry): number => {
  const total = entry.feedbackPositive + entry.feedbackNegative;
  if (total <= 0) return 0.5;
  return clamp01(entry.feedbackPositive / total);
};

const computeReuseProbability = (args: {
  hitScore: number;
  recencyScore: number;
  semanticScore: number;
}): number => clamp01(0.5 * args.hitScore + 0.3 * args.recencyScore + 0.2 * args.semanticScore);

const computeFinalScore = (
  textScore: number,
  confidenceScore: number,
  recencyScore: number,
  recallScore: number,
  feedbackScore: number,
): number =>
  0.45 * textScore + 0.2 * confidenceScore + 0.15 * recencyScore + 0.1 * recallScore +
  0.1 * feedbackScore;

const toContentHash = (content: string) => createHash("sha256").update(content).digest("hex");

const trimPersistentPrefix = (value: string): string => {
  let next = value.trim();
  while (next.startsWith("persistent:")) {
    next = next.slice("persistent:".length).trim();
  }
  return next;
};

const normalizeWorkingPrefix = (value: string): string => {
  if (!value.startsWith("working:")) {
    return value;
  }
  const suffix = value.slice("working:".length);
  let next = suffix;
  while (next.startsWith("working:")) {
    next = next.slice("working:".length);
  }
  return `working:${next}`;
};

export const canonicalizePersistentBlockId = (blockId: string): string => {
  const trimmed = blockId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withoutPersistentPrefix = trimPersistentPrefix(trimmed);
  const normalizedWorking = normalizeWorkingPrefix(withoutPersistentPrefix);
  return normalizedWorking || trimmed;
};

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

const getContentState = (block: ContextMemoryBlock): "active" | "tag_ref" => {
  if (block.content_state === "tag_ref") return "tag_ref";
  return "active";
};

const getTagId = (block: ContextMemoryBlock): string | null => {
  if (typeof block.tag_id === "string" && block.tag_id.trim()) return block.tag_id.trim();
  return null;
};

const getTagSummary = (block: ContextMemoryBlock): string | null => {
  if (typeof block.tag_summary === "string" && block.tag_summary.trim()) return block.tag_summary.trim();
  return null;
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
    tagSummary: string;
  }) {
    if (!this.ftsEnabled) return;

    this.handle.db.query("DELETE FROM persistent_memory_fts WHERE rowid = ?").run(entry.id);
    this.handle.db
      .query(
        "INSERT INTO persistent_memory_fts (rowid, entry_id, summary, content, tags, tag_summary) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.id, entry.summary, entry.content, entry.tagsJson, entry.tagSummary);
  }

  private getEntryRowByBlockId(blockId: string): PersistentMemoryEntryRow | null {
    return this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
           FROM persistent_memory_entries
          WHERE block_id = ?`,
      )
      .get(blockId) as PersistentMemoryEntryRow | null;
  }

  private getEntryRowById(entryId: number): PersistentMemoryEntryRow | null {
    return this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
           FROM persistent_memory_entries
          WHERE id = ?`,
      )
      .get(entryId) as PersistentMemoryEntryRow | null;
  }

  async appendEvent(args: {
    entryId?: number | null;
    blockId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt?: number;
  }): Promise<void> {
    const createdAt = args.createdAt ?? Date.now();
    this.handle.db
      .query(
        `INSERT INTO persistent_memory_events (entry_id, block_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        args.entryId ?? null,
        args.blockId ?? null,
        args.eventType,
        JSON.stringify(args.payload ?? {}),
        createdAt,
      );
  }

  async saveTagPayload(args: { tagId: string; fullContent: string }): Promise<void> {
    const tagId = args.tagId.trim();
    if (!tagId) return;
    const content = args.fullContent.trim();
    if (!content) return;

    const now = Date.now();
    this.handle.db
      .query(
        `INSERT INTO persistent_memory_tag_payloads (tag_id, full_content, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tag_id) DO UPDATE SET
           full_content = excluded.full_content,
           updated_at = excluded.updated_at`,
      )
      .run(tagId, content, now, now);
  }

  async resolveTag(tagId: string): Promise<string | null> {
    const normalized = tagId.trim();
    if (!normalized) return null;
    const row = this.handle.db
      .query("SELECT full_content FROM persistent_memory_tag_payloads WHERE tag_id = ?")
      .get(normalized) as { full_content: string } | null;
    return row?.full_content ?? null;
  }

  async tagEntryReference(args: {
    entryId: number;
    tagId: string;
    tagSummary: string;
    placeholderContent: string;
  }): Promise<void> {
    const now = Date.now();
    this.handle.db
      .query(
        `UPDATE persistent_memory_entries
            SET content_state = 'tag_ref',
                tag_id = ?,
                tag_summary = ?,
                content = ?,
                summary = ?,
                content_hash = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        args.tagId,
        args.tagSummary,
        args.placeholderContent,
        derivePersistentMemorySummary(args.placeholderContent),
        toContentHash(args.placeholderContent),
        now,
        args.entryId,
      );

    const row = this.getEntryRowById(args.entryId);
    if (row) {
      this.syncFtsRow({
        id: normalizeFinite(row.id),
        summary: row.summary,
        content: row.content,
        tagsJson: row.tags_json,
        tagSummary: row.tag_summary ?? "",
      });
      await this.appendEvent({
        entryId: normalizeFinite(row.id),
        blockId: row.block_id,
        eventType: "tag_ref_created",
        payload: {
          tag_id: args.tagId,
          tag_summary: args.tagSummary,
        },
        createdAt: now,
      });
    }
  }

  async hydrateTagRef(entry: PersistentMemoryEntry): Promise<PersistentMemoryEntry> {
    if (entry.contentState !== "tag_ref" || !entry.tagId) return entry;
    const fullContent = await this.resolveTag(entry.tagId);
    if (!fullContent) return entry;

    const now = Date.now();
    this.handle.db
      .query(
        `UPDATE persistent_memory_entries
            SET content = ?,
                summary = ?,
                content_state = 'active',
                rehydrated_at = ?,
                content_hash = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        fullContent,
        derivePersistentMemorySummary(fullContent),
        now,
        toContentHash(fullContent),
        now,
        entry.id,
      );

    const updated = this.getEntryRowByBlockId(entry.blockId);
    if (!updated) {
      return entry;
    }

    this.syncFtsRow({
      id: normalizeFinite(updated.id),
      summary: updated.summary,
      content: updated.content,
      tagsJson: updated.tags_json,
      tagSummary: updated.tag_summary ?? "",
    });
    await this.appendEvent({
      entryId: normalizeFinite(updated.id),
      blockId: updated.block_id,
      eventType: "tag_ref_hydrated",
      payload: {
        tag_id: entry.tagId,
      },
      createdAt: now,
    });
    return rowToEntry(updated);
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

      const sourceTier = args.sourceTier ?? "core";
      const memoryType = typeof block.type === "string" && block.type.trim() ? block.type.trim() : "memory";
      if (memoryType === "persistent_recall" || memoryType === "persistent_longterm_recall") {
        stats.skipped += 1;
        continue;
      }
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
      const contentState = getContentState(block);
      const tagId = getTagId(block);
      const tagSummary = getTagSummary(block);

      const existing = this.getEntryRowByBlockId(blockId);
      if (!existing) {
        const insertResult = this.handle.db
          .query(
            `INSERT INTO persistent_memory_entries (
               block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary, tags_json,
               confidence, decay, status, content_hash, first_seen_round, last_seen_round, source_task_id,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            blockId,
            sourceTier,
            memoryType,
            summary,
            content,
            contentState,
            tagId,
            tagSummary,
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
          this.syncFtsRow({
            id: insertedId,
            summary,
            content,
            tagsJson,
            tagSummary: tagSummary ?? "",
          });
        }
        stats.inserted += 1;
        continue;
      }

      if (existing.content_hash === contentHash) {
        this.handle.db
          .query(
            `UPDATE persistent_memory_entries
                SET last_seen_round = ?,
                    source_task_id = ?,
                    source_tier = ?,
                    content_state = ?,
                    tag_id = ?,
                    tag_summary = ?
              WHERE id = ?`,
          )
          .run(round, sourceTaskId, sourceTier, contentState, tagId, tagSummary, existing.id);
        stats.unchanged += 1;
        continue;
      }

      this.handle.db
        .query(
          `UPDATE persistent_memory_entries
              SET source_tier = ?,
                  memory_type = ?,
                  summary = ?,
                  content = ?,
                  content_state = ?,
                  tag_id = ?,
                  tag_summary = ?,
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
          sourceTier,
          memoryType,
          summary,
          content,
          contentState,
          tagId,
          tagSummary,
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
      this.syncFtsRow({
        id: normalizeFinite(existing.id),
        summary,
        content,
        tagsJson,
        tagSummary: tagSummary ?? "",
      });
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
      if (typeof item !== "string" || item.trim() === "") continue;
      const trimmed = item.trim();
      exclude.add(trimmed);
      const canonical = canonicalizePersistentBlockId(trimmed);
      if (canonical) {
        exclude.add(canonical);
      }
    }

    const limit = Math.max(1, Math.min(24, Math.trunc(args.limit)));
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
          `SELECT e.id, e.block_id, e.source_tier, e.memory_type, e.summary, e.content, e.content_state, e.tag_id, e.tag_summary,
                  e.tags_json, e.confidence, e.decay, e.status, e.content_hash, e.first_seen_round, e.last_seen_round,
                  e.source_task_id, e.created_at, e.updated_at, e.last_recalled_at, e.rehydrated_at, e.recall_count,
                  e.feedback_positive, e.feedback_negative,
                  bm25(persistent_memory_fts) AS rank
             FROM persistent_memory_fts
             JOIN persistent_memory_entries e ON e.id = persistent_memory_fts.rowid
            WHERE persistent_memory_fts MATCH ?
            LIMIT ?`,
        )
        .all(ftsQuery, limit * 8) as SearchRowWithRank[];

      const now = Date.now();
      const hits: PersistentMemorySearchHit[] = [];
      for (const row of rawRows) {
        const entry = rowToEntry(row);
        if (exclude.has(entry.blockId) || exclude.has(canonicalizePersistentBlockId(entry.blockId))) continue;
        const textScore = computeFtsTextScore(normalizeFinite(row.rank, 0));
        const confidenceScore = entry.confidence;
        const recencyScore = computeRecencyScore(entry.updatedAt, now);
        const recallScore = computeRecallScore(entry.recallCount);
        const feedbackScore = computeFeedbackScore(entry);
        const reuseProbability = computeReuseProbability({
          hitScore: recallScore,
          recencyScore,
          semanticScore: textScore,
        });
        const finalScore = computeFinalScore(
          textScore,
          confidenceScore,
          recencyScore,
          recallScore,
          feedbackScore,
        );
        hits.push({ entry, textScore, confidenceScore, recencyScore, recallScore, feedbackScore, reuseProbability, finalScore });
      }

      hits.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
        return b.entry.updatedAt - a.entry.updatedAt;
      });

      return { hits: hits.slice(0, limit), modeUsed: "fts" };
    } catch {
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
      clauses.push(
        "(summary LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!' OR tag_summary LIKE ? ESCAPE '!')",
      );
      params.push(term, term, term, term);
    }

    const whereSql = clauses.length > 0 ? clauses.join(" OR ") : "1 = 1";
    const rawRows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
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
      if (exclude.has(entry.blockId) || exclude.has(canonicalizePersistentBlockId(entry.blockId))) continue;
      const textScore = computeLikeTextScore(entry, tokens);
      if (textScore <= 0) continue;
      const confidenceScore = entry.confidence;
      const recencyScore = computeRecencyScore(entry.updatedAt, now);
      const recallScore = computeRecallScore(entry.recallCount);
      const feedbackScore = computeFeedbackScore(entry);
      const reuseProbability = computeReuseProbability({
        hitScore: recallScore,
        recencyScore,
        semanticScore: textScore,
      });
      const finalScore = computeFinalScore(
        textScore,
        confidenceScore,
        recencyScore,
        recallScore,
        feedbackScore,
      );
      hits.push({ entry, textScore, confidenceScore, recencyScore, recallScore, feedbackScore, reuseProbability, finalScore });
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
          `SELECT e.id, e.block_id, e.source_tier, e.memory_type, e.summary, e.content, e.content_state, e.tag_id, e.tag_summary,
                  e.tags_json, e.confidence, e.decay, e.status, e.content_hash, e.first_seen_round, e.last_seen_round,
                  e.source_task_id, e.created_at, e.updated_at, e.last_recalled_at, e.rehydrated_at, e.recall_count,
                  e.feedback_positive, e.feedback_negative,
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
      clauses.push(
        "(summary LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!' OR tag_summary LIKE ? ESCAPE '!')",
      );
      params.push(term, term, term, term);
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
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
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

  async getEntryById(entryId: number): Promise<PersistentMemoryEntry | null> {
    const normalizedId = Math.trunc(entryId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      return null;
    }
    const row = this.getEntryRowById(normalizedId);
    return row ? rowToEntry(row) : null;
  }

  async getEntryByBlockId(blockId: string): Promise<PersistentMemoryEntry | null> {
    const normalized = blockId.trim();
    if (!normalized) return null;
    const row = this.getEntryRowByBlockId(normalized);
    return row ? rowToEntry(row) : null;
  }

  async updateEntry(args: {
    entryId: number;
    patch: Partial<{
      content: string;
      summary: string;
      tags: string[];
      confidence: number;
      decay: number;
      status: string | null;
      sourceTier: "core" | "longterm";
      contentState: "active" | "tag_ref";
      tagId: string | null;
      tagSummary: string | null;
      sourceTaskId: string | null;
    }>;
  }): Promise<PersistentMemoryEntry | null> {
    const existing = await this.getEntryById(args.entryId);
    if (!existing) return null;

    const patch = args.patch;
    const content = typeof patch.content === "string" && patch.content.trim()
      ? patch.content.trim()
      : existing.content;
    const summary = typeof patch.summary === "string" && patch.summary.trim()
      ? patch.summary.trim()
      : derivePersistentMemorySummary(content);
    const tags = patch.tags ? normalizeTagList(patch.tags) : existing.tags;
    const tagsJson = JSON.stringify(tags);
    const confidence = typeof patch.confidence === "number"
      ? clamp01(patch.confidence)
      : existing.confidence;
    const decay = typeof patch.decay === "number"
      ? clamp01(patch.decay)
      : existing.decay;
    const status = patch.status === undefined ? existing.status : patch.status;
    const sourceTier = patch.sourceTier ?? existing.sourceTier;
    const contentState = patch.contentState ?? existing.contentState;
    const tagId = patch.tagId === undefined ? existing.tagId : patch.tagId;
    const tagSummary = patch.tagSummary === undefined ? existing.tagSummary : patch.tagSummary;
    const sourceTaskId = patch.sourceTaskId === undefined ? existing.sourceTaskId : patch.sourceTaskId;
    const contentHash = toContentHash(content);
    const now = Date.now();

    this.handle.db
      .query(
        `UPDATE persistent_memory_entries
            SET source_tier = ?,
                summary = ?,
                content = ?,
                content_state = ?,
                tag_id = ?,
                tag_summary = ?,
                tags_json = ?,
                confidence = ?,
                decay = ?,
                status = ?,
                source_task_id = ?,
                content_hash = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        sourceTier,
        summary,
        content,
        contentState,
        tagId,
        tagSummary,
        tagsJson,
        confidence,
        decay,
        status,
        sourceTaskId,
        contentHash,
        now,
        existing.id,
      );

    this.syncFtsRow({
      id: existing.id,
      summary,
      content,
      tagsJson,
      tagSummary: tagSummary ?? "",
    });

    const updated = this.getEntryRowById(existing.id);
    if (!updated) return null;
    await this.appendEvent({
      entryId: existing.id,
      blockId: existing.blockId,
      eventType: "entry_updated",
      payload: {
        content_state: contentState,
      },
      createdAt: now,
    });
    return rowToEntry(updated);
  }

  async deleteEntryById(entryId: number): Promise<boolean> {
    const existing = await this.getEntryById(entryId);
    if (!existing) return false;
    const now = Date.now();
    this.handle.db
      .query("DELETE FROM persistent_memory_entries WHERE id = ?")
      .run(existing.id);
    if (this.ftsEnabled) {
      this.handle.db.query("DELETE FROM persistent_memory_fts WHERE rowid = ?").run(existing.id);
    }
    await this.appendEvent({
      entryId: existing.id,
      blockId: existing.blockId,
      eventType: "entry_deleted",
      payload: {},
      createdAt: now,
    });
    return true;
  }

  async deleteEntryByBlockId(blockId: string): Promise<boolean> {
    const existing = await this.getEntryByBlockId(blockId);
    if (!existing) return false;
    return await this.deleteEntryById(existing.id);
  }

  async hydrateEntriesByTagId(tagId: string): Promise<PersistentMemoryEntry[]> {
    const normalized = tagId.trim();
    if (!normalized) return [];
    const rows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
           FROM persistent_memory_entries
          WHERE tag_id = ?
            AND content_state = 'tag_ref'`,
      )
      .all(normalized) as PersistentMemoryEntryRow[];

    const hydrated: PersistentMemoryEntry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      hydrated.push(await this.hydrateTagRef(entry));
    }
    return hydrated;
  }

  async applyFeedback(entryId: number, direction: "positive" | "negative"): Promise<void> {
    const id = Math.trunc(entryId);
    if (!Number.isFinite(id) || id <= 0) return;
    const column = direction === "positive" ? "feedback_positive" : "feedback_negative";
    this.handle.db
      .query(`UPDATE persistent_memory_entries SET ${column} = ${column} + 1 WHERE id = ?`)
      .run(id);
    const row = this.getEntryRowById(id);
    if (row) {
      await this.appendEvent({
        entryId: normalizeFinite(row.id),
        blockId: row.block_id,
        eventType: "feedback",
        payload: {
          direction,
        },
      });
    }
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

  async listRecent(limit = 30): Promise<PersistentMemoryEntry[]> {
    const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
           FROM persistent_memory_entries
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(normalizedLimit) as PersistentMemoryEntryRow[];
    return rows.map(rowToEntry);
  }

  async getStats(): Promise<{
    total: number;
    active: number;
    tagRef: number;
    byTier: Record<"core" | "longterm", number>;
  }> {
    const rows = this.handle.db
      .query(
        `SELECT source_tier, content_state, COUNT(1) AS total
           FROM persistent_memory_entries
          GROUP BY source_tier, content_state`,
      )
      .all() as Array<{ source_tier: "core" | "longterm"; content_state: "active" | "tag_ref"; total: number }>;

    let total = 0;
    let active = 0;
    let tagRef = 0;
    const byTier: Record<"core" | "longterm", number> = {
      core: 0,
      longterm: 0,
    };

    for (const row of rows) {
      const count = Math.max(0, Math.trunc(normalizeFinite(row.total)));
      total += count;
      if (row.content_state === "active") active += count;
      if (row.content_state === "tag_ref") tagRef += count;
      byTier[row.source_tier] += count;
    }

    return { total, active, tagRef, byTier };
  }

  async listAllEntries(): Promise<PersistentMemoryEntry[]> {
    const rows = this.handle.db
      .query(
        `SELECT id, block_id, source_tier, memory_type, summary, content, content_state, tag_id, tag_summary,
                tags_json, confidence, decay, status, content_hash, first_seen_round, last_seen_round,
                source_task_id, created_at, updated_at, last_recalled_at, rehydrated_at, recall_count,
                feedback_positive, feedback_negative
           FROM persistent_memory_entries
          ORDER BY id ASC`,
      )
      .all() as PersistentMemoryEntryRow[];

    return rows.map(rowToEntry);
  }

  async listTagPayloads(): Promise<PersistentMemoryTagPayloadRow[]> {
    return this.handle.db
      .query(
        `SELECT tag_id, full_content, created_at, updated_at
           FROM persistent_memory_tag_payloads
          ORDER BY updated_at DESC`,
      )
      .all() as PersistentMemoryTagPayloadRow[];
  }
}
