import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { lsTool } from "./ls";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-ls-test-"));
};

const outputLines = (output: string) =>
  output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").filter(Boolean);

describe("ls tool", () => {
  test("lists visible entries in stable name order and hides dotfiles by default", async () => {
    const workspace = await createWorkspaceTempDir();
    await Bun.write(join(workspace, "b.txt"), "b");
    await Bun.write(join(workspace, "a.txt"), "a");
    await Bun.write(join(workspace, ".env"), "x=1");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
    });

    expect(result.error).toBeUndefined();
    expect(result.method).toBe("builtin.fs");
    expect(result.command).toBe(`ls ${workspace}`);
    expect(result.output.endsWith("\n")).toBe(true);
    expect(outputLines(result.output)).toEqual(["a.txt", "b.txt"]);
  });

  test("includes dot and dotdot entries when all=true", async () => {
    const workspace = await createWorkspaceTempDir();
    await Bun.write(join(workspace, "a.txt"), "a");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
      all: true,
    });

    expect(result.error).toBeUndefined();
    const lines = outputLines(result.output);
    expect(lines).toContain(".");
    expect(lines).toContain("..");
    expect(lines).toContain("a.txt");
  });

  test("hides workspace protected entries while keeping non-sensitive dotfiles", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await mkdir(join(workspace, "secrets"), { recursive: true });
    await Bun.write(join(workspace, "agent.config.json"), "{}");
    await Bun.write(join(workspace, ".env"), "x=1");
    await Bun.write(join(workspace, ".cache"), "x=1");
    await Bun.write(join(workspace, "visible.txt"), "ok");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
      all: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain(".cache");
    expect(result.output).toContain("visible.txt");
    expect(outputLines(result.output)).not.toContain(".agent");
    expect(outputLines(result.output)).not.toContain("secrets");
    expect(outputLines(result.output)).not.toContain("agent.config.json");
    expect(outputLines(result.output)).not.toContain(".env");
  });

  test("hides workspace protected entries in long output and removes total line after filtering", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await mkdir(join(workspace, "secrets"), { recursive: true });
    await Bun.write(join(workspace, "agent.config.json"), "{}");
    await Bun.write(join(workspace, ".env"), "x=1");
    await Bun.write(join(workspace, ".cache"), "x=1");
    await Bun.write(join(workspace, "visible.txt"), "ok");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
      all: true,
      long: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain(".cache");
    expect(result.output).toContain("visible.txt");
    expect(result.output).not.toMatch(/\s\.agent(?:$| -> )/m);
    expect(result.output).not.toMatch(/\ssecrets(?:$| -> )/m);
    expect(result.output).not.toMatch(/\sagent\.config\.json(?:$| -> )/m);
    expect(result.output).not.toMatch(/\s\.env(?:$| -> )/m);
    expect(result.output).not.toMatch(/^total\s+\d+\b/m);
    expect(result.output).toMatch(/^[dl\-\?][rwx-]{9}\s+/m);
    expect(result.output).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(result.output).toMatch(/\s\.$/m);
    expect(result.output).toMatch(/\s\.\.$/m);
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

  test("denies listing workspace secrets directly", async () => {
    const workspace = await createWorkspaceTempDir();
    const protectedDir = join(workspace, "secrets");
    await mkdir(protectedDir, { recursive: true });

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: protectedDir,
    });

    expect(result.error).toBe("Permission denied: ls path not allowed");
  });

  test("returns standardized error for missing directory path", async () => {
    const workspace = await createWorkspaceTempDir();
    const missing = join(workspace, "missing-dir");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: missing,
    });

    expect(result.error).toBe("Directory path does not exist");
    expect(result.command).toBe(`ls ${missing}`);
  });

  test("returns standardized error for non-directory path", async () => {
    const workspace = await createWorkspaceTempDir();
    const filePath = join(workspace, "file.txt");
    await Bun.write(filePath, "x");

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: filePath,
    });

    expect(result.error).toBe("Path is not a directory");
    expect(result.command).toBe(`ls ${filePath}`);
  });

  test("shows symbolic link target in long output", async () => {
    const workspace = await createWorkspaceTempDir();
    const targetPath = join(workspace, "target.txt");
    const linkPath = join(workspace, "link.txt");
    await Bun.write(targetPath, "target");

    try {
      await symlink("target.txt", linkPath);
    } catch {
      return;
    }

    const result = await (lsTool({ workspace }) as any).execute({
      dirpath: workspace,
      long: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("link.txt -> target.txt");
  });
});
