import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { workspace_check } from "./workspace_check";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-workspace-check-test-"));
};

describe("workspace_check", () => {
  test("creates missing AGENT.md, agent.config.json, memory and secrets", async () => {
    const workspace = await createWorkspaceTempDir();
    await workspace_check(workspace);

    expect(await Bun.file(join(workspace, "AGENT.md")).exists()).toBe(true);
    expect(await Bun.file(join(workspace, "agent.config.json")).exists()).toBe(true);
    expect((await stat(join(workspace, "memory"))).isDirectory()).toBe(true);
    expect((await stat(join(workspace, "secrets"))).isDirectory()).toBe(true);
  });

  test("does not overwrite existing AGENT.md and agent.config.json", async () => {
    const workspace = await createWorkspaceTempDir();
    const agentPath = join(workspace, "AGENT.md");
    const configPath = join(workspace, "agent.config.json");
    const customAgent = "# custom agent";
    const customConfig = "{\"agent\":{\"name\":\"Custom\"}}";

    await writeFile(agentPath, customAgent, "utf8");
    await writeFile(configPath, customConfig, "utf8");

    await workspace_check(workspace);

    expect(await readFile(agentPath, "utf8")).toBe(customAgent);
    expect(await readFile(configPath, "utf8")).toBe(customConfig);
  });
});
