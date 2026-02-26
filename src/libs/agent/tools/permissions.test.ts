import { describe, expect, test } from "bun:test";
import {
  canUseBackground,
  canCopyFrom,
  canUseBash,
  canListDir,
  canMoveTo,
  canReadFile,
  canReadTree,
  canRipgrep,
  canUseGit,
  canVisitUrl,
  canWriteFile,
} from "./permissions";

describe("agent tool permissions", () => {
  test("builtin deny rules override allow rules", () => {
    expect(
      canReadFile("../etc/passwd", {
        read: { allow: [".*"] },
      }),
    ).toBe(false);
  });

  test("user deny rules override user allow rules", () => {
    expect(
      canWriteFile("/tmp/foo.txt", {
        write: {
          allow: [".*"],
          deny: ["^/tmp/"],
        },
      }),
    ).toBe(false);
  });

  test("no rules defaults to allow for safe targets", () => {
    expect(canReadFile("/Users/example/work/file.txt")).toBe(true);
  });

  test("hard-blocks {workspace}/.agent paths before user rules", () => {
    const workspace = "/Users/example/workspace";

    expect(
      canReadFile(`${workspace}/.agent/secret.txt`, {
        read: { allow: [".*"] },
      }, workspace),
    ).toBe(false);
    expect(
      canListDir(`${workspace}/.agent`, {
        ls: { allow: [".*"] },
      }, workspace),
    ).toBe(false);
    expect(
      canReadTree(`${workspace}/.agent`, {
        tree: { allow: [".*"] },
      }, workspace),
    ).toBe(false);
    expect(
      canRipgrep(`${workspace}/.agent`, {
        ripgrep: { allow: [".*"] },
      }, workspace),
    ).toBe(false);
  });

  test("hard-block skips parsing invalid user regex for {workspace}/.agent", () => {
    const workspace = "/Users/example/workspace";

    expect(
      canReadFile(`${workspace}/.agent/secret.txt`, {
        read: { allow: ["("] },
      }, workspace),
    ).toBe(false);
  });

  test("non-.agent paths still use user rules when workspace is provided", () => {
    const workspace = "/Users/example/workspace";

    expect(
      canReadFile(`${workspace}/visible.txt`, {
        read: { allow: ["^/Users/example/workspace/visible\\.txt$"] },
      }, workspace),
    ).toBe(true);
    expect(
      canReadFile(`${workspace}/other.txt`, {
        read: { allow: ["^/Users/example/workspace/visible\\.txt$"] },
      }, workspace),
    ).toBe(false);
  });

  test("webfetch blocks local file protocol by builtin rules", () => {
    expect(
      canVisitUrl("file:///etc/passwd", {
        webfetch: { allow: [".*"] },
      }),
    ).toBe(false);
  });

  test("cp permission follows tools.cp rules", () => {
    expect(
      canCopyFrom("/Users/example/work/file.txt", {
        cp: { allow: ["^/Users/example/work/.*"] },
      }),
    ).toBe(true);
    expect(
      canCopyFrom("/tmp/file.txt", {
        cp: { allow: ["^/Users/example/work/.*"] },
      }),
    ).toBe(false);
  });

  test("mv permission follows tools.mv rules", () => {
    expect(
      canMoveTo("/Users/example/work/file.txt", {
        mv: { allow: ["^/Users/example/work/.*"] },
      }),
    ).toBe(true);
    expect(
      canMoveTo("/tmp/file.txt", {
        mv: { deny: ["^/tmp/"] },
      }),
    ).toBe(false);
  });

  test("git permission checks cwd path", () => {
    expect(
      canUseGit("/Users/example/work/repo", {
        git: { allow: ["^/Users/example/work/.*"] },
      }),
    ).toBe(true);
    expect(
      canUseGit("/Users/example/secret/repo", {
        git: { deny: ["^/Users/example/secret/.*"] },
      }),
    ).toBe(false);
  });

  test("bash permission checks cwd path", () => {
    expect(
      canUseBash("/Users/example/work/repo", {
        bash: { allow: ["^/Users/example/work/.*"] },
      }),
    ).toBe(true);
    expect(
      canUseBash("/Users/example/secret/repo", {
        bash: { deny: ["^/Users/example/secret/.*"] },
      }),
    ).toBe(false);
  });

  test("background permission checks cwd path", () => {
    expect(
      canUseBackground("/Users/example/work/repo", {
        background: { allow: ["^/Users/example/work/.*"] },
      }),
    ).toBe(true);
    expect(
      canUseBackground("/Users/example/secret/repo", {
        background: { deny: ["^/Users/example/secret/.*"] },
      }),
    ).toBe(false);
  });
});
