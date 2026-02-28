import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalizePersistentBlockId } from "../libs/agent/memory/persistent_store";

type PersistentEntry = {
  blockId: string;
  type: string;
  content: string;
  [key: string]: unknown;
};

const parseLines = (content: string): PersistentEntry[] => {
  const entries: PersistentEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as PersistentEntry;
      if (typeof parsed.blockId === "string" && typeof parsed.type === "string") {
        entries.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries;
};

const serializeLines = (entries: PersistentEntry[]): string =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "./Playground/.agent/persistent-memory.jsonl" },
  },
});

const filepath = resolve(values.file);
const backupPath = `${filepath}.bak.${Date.now()}`;
const raw = readFileSync(filepath, "utf8");
copyFileSync(filepath, backupPath);

const source = parseLines(raw);
const cleaned = source
  .filter((entry) => entry.type !== "persistent_recall" && entry.type !== "persistent_longterm_recall")
  .map((entry) => ({
    ...entry,
    blockId: canonicalizePersistentBlockId(entry.blockId),
  }))
  .filter((entry) => entry.blockId !== "");

const dedupedMap = new Map<string, PersistentEntry>();
for (const entry of cleaned) {
  dedupedMap.set(entry.blockId, entry);
}

const deduped = Array.from(dedupedMap.values());
writeFileSync(filepath, serializeLines(deduped), "utf8");

console.log(JSON.stringify({
  file: filepath,
  backup: backupPath,
  before: source.length,
  after: deduped.length,
  removed: source.length - deduped.length,
}, null, 2));
