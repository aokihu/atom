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
});
