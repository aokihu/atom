import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { treeTool } from "./tree";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-tree-test-"));
};

describe("tree tool", () => {
  test("hides dotfiles by default and shows them when all=true", async () => {
    const dir = await createWorkspaceTempDir();
    await mkdir(join(dir, "sub"), { recursive: true });
    await Bun.write(join(dir, "visible.txt"), "ok");
    await Bun.write(join(dir, ".hidden.txt"), "secret");

    const hiddenByDefault = await (treeTool({}) as any).execute({ dirpath: dir });
    expect(hiddenByDefault.error).toBeUndefined();
    expect(hiddenByDefault.output).toContain("visible.txt");
    expect(hiddenByDefault.output).not.toContain(".hidden.txt");

    const showAll = await (treeTool({}) as any).execute({
      dirpath: dir,
      all: true,
    });
    expect(showAll.output).toContain(".hidden.txt");
  });

  test("respects level depth limit", async () => {
    const dir = await createWorkspaceTempDir();
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await Bun.write(join(dir, "a", "b", "deep.txt"), "deep");

    const result = await (treeTool({}) as any).execute({
      dirpath: dir,
      level: 1,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("a/");
    expect(result.output).not.toContain("deep.txt");
  });

  test("hides workspace protected entries even when all=true", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, "sub"), { recursive: true });
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await mkdir(join(workspace, "secrets"), { recursive: true });
    await Bun.write(join(workspace, "visible.txt"), "ok");
    await Bun.write(join(workspace, ".cache"), "ok");
    await Bun.write(join(workspace, ".env"), "x=1");
    await Bun.write(join(workspace, "agent.config.json"), "{}");
    await Bun.write(join(workspace, "message_gateway.config.json"), "{}");
    await Bun.write(join(workspace, ".agent", "secret.txt"), "secret");
    await Bun.write(join(workspace, "secrets", "secret.txt"), "secret");

    const result = await (treeTool({ workspace }) as any).execute({
      dirpath: workspace,
      all: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("sub/");
    expect(result.output).toContain("visible.txt");
    expect(result.output).toContain(".cache");
    expect(result.output).not.toContain(".agent");
    expect(result.output).not.toContain("secrets");
    expect(result.output).not.toContain("agent.config.json");
    expect(result.output).not.toContain("message_gateway.config.json");
    expect(result.output).not.toContain(".env");
    expect(result.output).not.toContain("secret.txt");
    expect(result.output).toContain("1 directory, 2 files");
  });

  test("denies reading workspace .agent directly", async () => {
    const workspace = await createWorkspaceTempDir();
    const protectedDir = join(workspace, ".agent");
    await mkdir(protectedDir, { recursive: true });

    const result = await (treeTool({ workspace }) as any).execute({
      dirpath: protectedDir,
    });

    expect(result.error).toBe("Permission denied: tree path not allowed");
  });

  test("denies reading workspace secrets directly", async () => {
    const workspace = await createWorkspaceTempDir();
    const protectedDir = join(workspace, "secrets");
    await mkdir(protectedDir, { recursive: true });

    const result = await (treeTool({ workspace }) as any).execute({
      dirpath: protectedDir,
    });

    expect(result.error).toBe("Permission denied: tree path not allowed");
  });
});
