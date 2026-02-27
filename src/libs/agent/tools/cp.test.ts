import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cpTool } from "./cp";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-cp-test-"));
};

describe("cp tool", () => {
  test("returns error when destination exists and overwrite is false", async () => {
    const dir = await createWorkspaceTempDir();
    const source = join(dir, "source.txt");
    const destination = join(dir, "destination.txt");
    await Bun.write(source, "hello");
    await Bun.write(destination, "world");

    const result = await (cpTool({}) as any).execute({
      source,
      destination,
    });

    expect(result.error).toContain("Destination already exists");
  });

  test("copies file when overwrite is true", async () => {
    const dir = await createWorkspaceTempDir();
    const source = join(dir, "source.txt");
    const destination = join(dir, "destination.txt");
    await Bun.write(source, "hello");
    await Bun.write(destination, "world");

    const result = await (cpTool({}) as any).execute({
      source,
      destination,
      overwrite: true,
    });

    expect(result.success).toBe(true);
    expect(await Bun.file(destination).text()).toBe("hello");
  });

  test("denies copying from or to protected workspace paths", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, "secrets"), { recursive: true });
    const protectedSource = join(workspace, ".env");
    const protectedDestination = join(workspace, "secrets", "x.txt");
    const safeSource = join(workspace, "safe.txt");
    const safeDestination = join(workspace, "safe-copy.txt");
    await Bun.write(protectedSource, "secret");
    await Bun.write(safeSource, "safe");

    const fromProtected = await (cpTool({ workspace }) as any).execute({
      source: protectedSource,
      destination: safeDestination,
    });
    expect(fromProtected.error).toBe("Permission denied: cp path not allowed");

    const toProtected = await (cpTool({ workspace }) as any).execute({
      source: safeSource,
      destination: protectedDestination,
    });
    expect(toProtected.error).toBe("Permission denied: cp path not allowed");
  });
});
