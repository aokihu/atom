import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  gitTool,
  resetGitAvailabilityCacheForTest,
  setGitAvailabilityCacheForTest,
} from "./git";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-git-test-"));
};

describe("git tool", () => {
  test("returns permission error when cwd is denied", async () => {
    const result = await (gitTool({
      permissions: {
        permissions: {
          git: {
            deny: [".*"],
          },
        },
      },
    }) as any).execute({
      cwd: "/Users/example/repo",
      subcommand: "status",
    });

    expect(result.error).toBe("Permission denied: git path not allowed");
  });

  test("returns runtime error when git is unavailable", async () => {
    setGitAvailabilityCacheForTest(false);

    const result = await (gitTool({}) as any).execute({
      cwd: process.cwd(),
      subcommand: "status",
    });

    expect(result.error).toBe("git command is not available in runtime environment");
    resetGitAvailabilityCacheForTest();
  });

  test("runs git status in a repo", async () => {
    resetGitAvailabilityCacheForTest();
    const dir = await createWorkspaceTempDir();
    await Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.write(join(dir, "README.md"), "hello");

    const result = await (gitTool({}) as any).execute({
      cwd: dir,
      subcommand: "status",
      args: ["--short"],
    });

    expect(result.success).toBe(true);
    expect(typeof result.stdout).toBe("string");
  });
});
