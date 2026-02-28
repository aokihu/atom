import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "./Playground" },
    p50: { type: "string", default: "0" },
    p95: { type: "string", default: "0" },
    beforeTaskP95Ms: { type: "string", default: "0" },
    afterTaskP95Ms: { type: "string", default: "0" },
  },
});

const workspace = resolve(values.workspace);
const outputDir = join(workspace, ".agent", "log");
mkdirSync(outputDir, { recursive: true });

const now = new Date();
const token = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const filepath = join(outputDir, `baseline_context_perf_${token}.json`);

const payload = {
  generated_at: now.toISOString(),
  context_payload_bytes: {
    p50: Number(values.p50),
    p95: Number(values.p95),
  },
  lifecycle_latency_ms: {
    beforeTask_p95: Number(values.beforeTaskP95Ms),
    afterTask_p95: Number(values.afterTaskP95Ms),
  },
};

writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
console.log(filepath);
