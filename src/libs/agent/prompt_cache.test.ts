import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { createAgentPromptWatcher, loadOrCompileSystemPrompt } from "./prompt_cache";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-prompt-cache-test-"));
};

const waitUntil = async (check: () => boolean, timeoutMs = 2500) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timeout");
    }
    await Bun.sleep(20);
  }
};

describe("loadOrCompileSystemPrompt", () => {
  test("compiles and persists cache on miss", async () => {
    const workspace = await createWorkspaceTempDir();
    await writeFile(join(workspace, "AGENT.md"), "# agent v1\n", "utf8");
    let compileCount = 0;

    const result = await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v1";
      },
    });

    expect(result.source).toBe("compiled");
    expect(result.systemPrompt).toBe("compiled-v1");
    expect(result.checksum.length).toBeGreaterThan(0);
    expect(compileCount).toBe(1);
    expect(await readFile(join(workspace, ".agent", "compiled_prompt.md"), "utf8")).toBe(
      "compiled-v1",
    );
  });

  test("uses cache when checksum is unchanged", async () => {
    const workspace = await createWorkspaceTempDir();
    await writeFile(join(workspace, "AGENT.md"), "# agent v1\n", "utf8");
    let compileCount = 0;

    const first = await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v1";
      },
    });
    const second = await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v2";
      },
    });

    expect(first.source).toBe("compiled");
    expect(second.source).toBe("cache");
    expect(second.systemPrompt).toBe("compiled-v1");
    expect(compileCount).toBe(1);
  });

  test("recompiles when AGENT.md checksum changes", async () => {
    const workspace = await createWorkspaceTempDir();
    await writeFile(join(workspace, "AGENT.md"), "# agent v1\n", "utf8");
    let compileCount = 0;

    await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v1";
      },
    });

    await writeFile(join(workspace, "AGENT.md"), "# agent v2\n", "utf8");

    const second = await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v2";
      },
    });

    expect(second.source).toBe("compiled");
    expect(second.systemPrompt).toBe("compiled-v2");
    expect(compileCount).toBe(2);
  });

  test("falls back to compile when meta is corrupted", async () => {
    const workspace = await createWorkspaceTempDir();
    await writeFile(join(workspace, "AGENT.md"), "# agent v1\n", "utf8");
    let compileCount = 0;

    await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v1";
      },
    });

    await writeFile(join(workspace, ".agent", "compiled_prompt.meta.json"), "{broken json", "utf8");

    const second = await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => {
        compileCount += 1;
        return "compiled-v2";
      },
    });

    expect(second.source).toBe("compiled");
    expect(second.systemPrompt).toBe("compiled-v2");
    expect(compileCount).toBe(2);
  });
});

describe("createAgentPromptWatcher", () => {
  test("keeps old prompt on compile failure and applies later successful update", async () => {
    const workspace = await createWorkspaceTempDir();
    const agentPath = join(workspace, "AGENT.md");
    const cachePath = join(workspace, ".agent", "compiled_prompt.md");
    await writeFile(agentPath, "# agent v1\n", "utf8");

    const initial = await loadOrCompileSystemPrompt({
      workspace,
      compileSystemPrompt: async () => "compiled:# agent v1",
    });

    const applied: string[] = [];
    const warnings: string[] = [];
    const watcher = createAgentPromptWatcher({
      workspace,
      initialChecksum: initial.checksum,
      compileSystemPrompt: async () => {
        const current = (await readFile(agentPath, "utf8")).trim();
        if (current.includes("v2")) {
          throw new Error("compile failed");
        }
        return `compiled:${current}`;
      },
      onPromptCompiled: ({ systemPrompt }) => {
        applied.push(systemPrompt);
      },
      warn: (message) => {
        warnings.push(message);
      },
      debounceMs: 120,
    });

    watcher.start();
    try {
      await writeFile(agentPath, "# agent v2\n", "utf8");
      await waitUntil(() => warnings.length > 0);
      expect(applied).toHaveLength(0);
      expect(await readFile(cachePath, "utf8")).toBe("compiled:# agent v1");

      await writeFile(agentPath, "# agent v3\n", "utf8");
      await waitUntil(() => applied.length === 1);
      expect(applied[0]).toBe("compiled:# agent v3");
      expect(await readFile(cachePath, "utf8")).toBe("compiled:# agent v3");
    } finally {
      await watcher.stop();
    }
  });
});
