import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "./Playground" },
    persistentRecallCount: { type: "string", default: "0" },
  },
});

const workspace = resolve(values.workspace);
const outputDir = join(workspace, ".agent", "log");
mkdirSync(outputDir, { recursive: true });

const now = new Date();
const token = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const filepath = join(outputDir, `baseline_memory_growth_${token}.json`);

const payload = {
  generated_at: now.toISOString(),
  persistent_memory_entries: {
    persistent_recall_like_count: Number(values.persistentRecallCount),
  },
};

writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
console.log(filepath);
