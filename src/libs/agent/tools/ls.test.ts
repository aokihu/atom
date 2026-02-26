import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { lsTool } from "./ls";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-ls-test-"));
};

describe("ls tool", () => {
  test("hides workspace .agent in default output while keeping other dotfiles", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await Bun.write(join(workspace, ".env"), "x=1");
    await Bun.write(join(workspace, "visible.txt"), "ok");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
      all: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain(".env");
    expect(result.output).toContain("visible.txt");
    expect(
      result.output.split("\n").some((line: string) => line.trim() === ".agent"),
    ).toBe(false);
  });

  test("hides workspace .agent in long output and removes total line after filtering", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await Bun.write(join(workspace, ".env"), "x=1");
    await Bun.write(join(workspace, "visible.txt"), "ok");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
      all: true,
      long: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain(".env");
    expect(result.output).toContain("visible.txt");
    expect(result.output).not.toMatch(/\s\.agent(?:$| -> )/m);
    expect(result.output).not.toMatch(/^total\s+\d+\b/m);
  });

  test("denies listing workspace .agent directly", async () => {
    const workspace = await createWorkspaceTempDir();
    const protectedDir = join(workspace, ".agent");
    await mkdir(protectedDir, { recursive: true });

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: protectedDir,
    });

    expect(result.error).toBe("Permission denied: ls path not allowed");
  });
});
