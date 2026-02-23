import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { mvTool } from "./mv";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-mv-test-"));
};

describe("mv tool", () => {
  test("returns error when destination exists and overwrite is false", async () => {
    const dir = await createWorkspaceTempDir();
    const source = join(dir, "source.txt");
    const destination = join(dir, "destination.txt");
    await Bun.write(source, "hello");
    await Bun.write(destination, "world");

    const result = await (mvTool({}) as any).execute({
      source,
      destination,
    });

    expect(result.error).toContain("Destination already exists");
    expect(await Bun.file(source).text()).toBe("hello");
  });

  test("moves file when overwrite is true", async () => {
    const dir = await createWorkspaceTempDir();
    const source = join(dir, "source.txt");
    const destination = join(dir, "destination.txt");
    await Bun.write(source, "hello");
    await Bun.write(destination, "world");

    const result = await (mvTool({}) as any).execute({
      source,
      destination,
      overwrite: true,
    });

    expect(result.success).toBe(true);
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await Bun.file(destination).text()).toBe("hello");
  });
});
