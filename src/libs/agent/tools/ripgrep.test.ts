import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ripgrepTool } from "./ripgrep";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-rg-test-"));
};

describe("ripgrep tool", () => {
  test("excludes workspace .agent subtree from search results", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });

    const token = "ATOM_SECRET_TOKEN_9c65f65c";
    await Bun.write(join(workspace, ".agent", "secret.txt"), `secret ${token}\n`);
    await Bun.write(join(workspace, "visible.txt"), `visible ${token}\n`);

    const result = await (ripgrepTool({ workspace }) as any).execute({
      dirpath: workspace,
      pattern: token,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("visible.txt");
    expect(result.output).not.toContain("secret.txt");
    expect(result.output).not.toContain(`${workspace}/.agent`);
  });

  test("denies searching workspace .agent directly", async () => {
    const workspace = await createWorkspaceTempDir();
    const protectedDir = join(workspace, ".agent");
    await mkdir(protectedDir, { recursive: true });
    await Bun.write(join(protectedDir, "secret.txt"), "secret");

    const result = await (ripgrepTool({ workspace }) as any).execute({
      dirpath: protectedDir,
      pattern: "secret",
    });

    expect(result.error).toBe("Permission denied: ripgrep path not allowed");
  });
});
