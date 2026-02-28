import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  TaskInputPolicy,
  compressTextDeterministic,
  estimateTextTokens,
} from "./input_policy";

const createLongInput = (): string =>
  [
    "Header line",
    ...Array.from({ length: 1200 }, (_, index) => {
      const a = String.fromCharCode(97 + (index % 26));
      const b = String.fromCharCode(97 + ((index + 11) % 26));
      const c = String.fromCharCode(97 + ((index + 17) % 26));
      return `narrative ${a}${b}${c} repeated context without urls or stack traces for compression`;
    }),
    "error: failed to connect at service.ts:10:3",
    "https://example.com/diagnostics/runbook",
    "Tail line",
  ].join("\n");

describe("task input policy", () => {
  test("keeps original input when token estimate is below threshold", () => {
    const policy = new TaskInputPolicy({
      enabled: true,
      maxInputTokens: 5000,
      summarizeTargetTokens: 1200,
      spoolOriginalInput: true,
      spoolDirectory: ".agent/inbox",
    });
    const input = "short request";

    const result = policy.apply({
      input,
      taskId: "task-short",
      workspace: "/tmp/atom-input-policy-short",
    });

    expect(result.input).toBe(input);
    expect(result.ingress.compressed).toBe(false);
    expect(result.ingress.spooledPath).toBeUndefined();
  });

  test("compresses oversized input and writes original content to spool path", async () => {
    const workspace = `/tmp/atom-input-policy-${Date.now().toString(36)}`;
    await mkdir(workspace, { recursive: true });
    const policy = new TaskInputPolicy({
      enabled: true,
      maxInputTokens: 600,
      summarizeTargetTokens: 240,
      spoolOriginalInput: true,
      spoolDirectory: ".agent/inbox",
    });
    const input = createLongInput();

    const result = policy.apply({
      input,
      taskId: "task-long",
      workspace,
    });

    expect(result.ingress.compressed).toBe(true);
    expect(result.ingress.originalBytes).toBeGreaterThan(result.ingress.summaryBytes);
    expect(result.input).toContain("[input_policy]");
    expect(result.input).toContain("<<<SUMMARY>>>");
    expect(result.ingress.spooledPath).toBe(join(workspace, ".agent/inbox", "task-long.txt"));

    const original = await readFile(result.ingress.spooledPath!, "utf8");
    expect(original).toBe(input);

    await rm(workspace, { recursive: true, force: true });
  });

  test("deterministic compression reduces token estimate", () => {
    const input = createLongInput();
    const summary = compressTextDeterministic(input, { targetTokens: 180 });
    expect(summary.length).toBeGreaterThan(0);
    expect(estimateTextTokens(summary)).toBeLessThan(estimateTextTokens(input));
  });
});
