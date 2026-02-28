import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTaskInputPolicy } from "./input_policy";

describe("input_policy", () => {
  test("compresses oversized input and spools original", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-input-policy-"));
    const oversized = Array.from({ length: 1200 }, (_, i) => `line ${i} https://example.com/${i}`).join("\n");

    const result = applyTaskInputPolicy({
      taskId: "task-1",
      workspace,
      input: oversized,
      config: {
        enabled: true,
        autoCompress: true,
        maxInputTokens: 300,
        summarizeTargetTokens: 120,
      },
    });

    expect(result.ingress.compressed).toBe(true);
    expect(result.ingress.spooledPath).toBeDefined();
    expect(result.input).toContain("[INPUT_COMPRESSED]");

    const spooled = await readFile(result.ingress.spooledPath!, "utf8");
    expect(spooled).toBe(oversized);

    await rm(workspace, { recursive: true, force: true });
  });

  test("keeps input unchanged when under threshold", () => {
    const input = "hello world";
    const result = applyTaskInputPolicy({
      taskId: "task-2",
      workspace: "/tmp",
      input,
      config: {
        enabled: true,
        autoCompress: true,
        maxInputTokens: 1000,
        summarizeTargetTokens: 200,
      },
    });

    expect(result.ingress.compressed).toBe(false);
    expect(result.input).toBe(input);
  });
});
