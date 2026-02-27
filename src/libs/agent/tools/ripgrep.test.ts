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
  test("excludes workspace protected entries from search results", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await mkdir(join(workspace, "secrets"), { recursive: true });
    await mkdir(join(workspace, "nested"), { recursive: true });

    const token = "ATOM_SECRET_TOKEN_9c65f65c";
    await Bun.write(join(workspace, ".agent", "secret.txt"), `secret ${token}\n`);
    await Bun.write(join(workspace, "secrets", "secret.txt"), `secret ${token}\n`);
    await Bun.write(join(workspace, "agent.config.json"), `{\"api_key\":\"${token}\"}\n`);
    await Bun.write(join(workspace, ".env.local"), `TOKEN=${token}\n`);
    await Bun.write(join(workspace, "nested", ".env.production"), `TOKEN=${token}\n`);
    await Bun.write(join(workspace, "visible.txt"), `visible ${token}\n`);

    const result = await (ripgrepTool({ workspace }) as any).execute({
      dirpath: workspace,
      pattern: token,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("visible.txt");
    expect(result.output).not.toContain("secret.txt");
    expect(result.output).not.toContain(`${workspace}/.agent`);
    expect(result.output).not.toContain("secrets/secret.txt");
    expect(result.output).not.toContain("agent.config.json");
    expect(result.output).not.toContain(".env.local");
    expect(result.output).not.toContain(".env.production");
  });

  test("denies searching protected paths directly", async () => {
    const workspace = await createWorkspaceTempDir();
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await mkdir(join(workspace, "secrets"), { recursive: true });
    await Bun.write(join(workspace, "agent.config.json"), "{}");
    await Bun.write(join(workspace, ".env"), "x=1");

    for (const protectedPath of [
      join(workspace, ".agent"),
      join(workspace, "secrets"),
      join(workspace, "agent.config.json"),
      join(workspace, ".env"),
    ]) {
      const result = await (ripgrepTool({ workspace }) as any).execute({
        dirpath: protectedPath,
        pattern: "secret",
      });

      expect(result.error).toBe("Permission denied: ripgrep path not allowed");
    }
  });
});
