import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { PersistentMemoryEntry } from "./persistent_types";

const RECALL_MEMORY_TYPES = new Set(["persistent_recall", "persistent_longterm_recall"]);

const parseLines = (content: string): PersistentMemoryEntry[] => {
  const entries: PersistentMemoryEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as PersistentMemoryEntry;
      if (typeof parsed.blockId === "string" && typeof parsed.content === "string") {
        entries.push(parsed);
      }
    } catch {
      // ignore invalid lines
    }
  }
  return entries;
};

const serializeLines = (entries: PersistentMemoryEntry[]): string =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");

export const canonicalizePersistentBlockId = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  const noPersistentPrefix = trimmed.replace(/^(persistent:)+/i, "");
  const noExtraWorkingPrefix = noPersistentPrefix.replace(/^(working:)+/i, "working:");
  return noExtraWorkingPrefix;
};

export const hashPersistentContent = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export class PersistentMemoryStore {
  private readonly storagePath: string;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, PersistentMemoryEntry>();

  constructor(args: { storagePath: string; maxEntries: number }) {
    this.storagePath = args.storagePath;
    this.maxEntries = Math.max(1, Math.floor(args.maxEntries));
    this.bootstrap();
  }

  private bootstrap() {
    try {
      const content = readFileSync(this.storagePath, "utf8");
      const parsed = parseLines(content);
      for (const entry of parsed) {
        const key = canonicalizePersistentBlockId(entry.blockId);
        if (!key) continue;
        this.entries.set(key, {
          ...entry,
          blockId: key,
        });
      }
    } catch {
      // ignore missing file
    }
  }

  private persist() {
    mkdirSync(dirname(this.storagePath), { recursive: true });
    writeFileSync(this.storagePath, serializeLines(this.listAll()), "utf8");
  }

  listAll(): PersistentMemoryEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return a.blockId.localeCompare(b.blockId);
    });
  }

  upsert(entries: PersistentMemoryEntry[]): number {
    let count = 0;

    for (const entry of entries) {
      if (RECALL_MEMORY_TYPES.has(entry.type)) {
        continue;
      }

      const blockId = canonicalizePersistentBlockId(entry.blockId);
      if (!blockId) {
        continue;
      }

      this.entries.set(blockId, {
        ...entry,
        blockId,
      });
      count += 1;
    }

    const ordered = this.listAll();
    if (ordered.length > this.maxEntries) {
      const toDrop = ordered.slice(this.maxEntries);
      for (const entry of toDrop) {
        this.entries.delete(entry.blockId);
      }
    }

    if (count > 0) {
      this.persist();
    }

    return count;
  }

  recall(args: { excludeBlockIds: string[]; limit: number }): PersistentMemoryEntry[] {
    const exclude = new Set(args.excludeBlockIds.map(canonicalizePersistentBlockId));
    return this.listAll()
      .filter((entry) => !exclude.has(entry.blockId))
      .slice(0, Math.max(1, Math.floor(args.limit)));
  }
}

export const __persistentStoreInternals = {
  parseLines,
  serializeLines,
};
