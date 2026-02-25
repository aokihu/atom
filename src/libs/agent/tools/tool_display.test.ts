import { describe, expect, test } from "bun:test";

import { buildToolCallDisplay, buildToolResultDisplay } from "./tool_display";

const getFieldValue = (display: ReturnType<typeof buildToolCallDisplay> | ReturnType<typeof buildToolResultDisplay>, label: string) => {
  if (!display) return undefined;
  const fields = Array.isArray((display.data as Record<string, unknown>).fields)
    ? ((display.data as Record<string, unknown>).fields as Array<Record<string, unknown>>)
    : [];
  const match = fields.find((field) => field.label === label);
  return typeof match?.value === "string" ? match.value : undefined;
};

describe("tool display builders", () => {
  test("builds call displays for all builtin tools", () => {
    const samples: Array<[string, unknown, string]> = [
      ["read", { filepath: "/tmp/a.txt" }, "builtin.read.call"],
      ["write", { filepath: "/tmp/a.txt", content: "hello", append: true }, "builtin.write.call"],
      ["ls", { dirpath: "/tmp/", all: true, long: false }, "builtin.ls.call"],
      ["tree", { dirpath: "/tmp/", level: 2, all: false }, "builtin.tree.call"],
      ["ripgrep", { dirpath: "/tmp/", pattern: "foo", caseSensitive: false }, "builtin.ripgrep.call"],
      ["cp", { source: "/tmp/a", destination: "/tmp/b", recursive: true, overwrite: false }, "builtin.cp.call"],
      ["mv", { source: "/tmp/a", destination: "/tmp/b", overwrite: true }, "builtin.mv.call"],
      ["git", { cwd: "/tmp", subcommand: "status", args: ["--short"] }, "builtin.git.call"],
      ["bash", { action: "start", mode: "once", cwd: "/tmp", command: "pwd" }, "builtin.bash.start.call"],
      ["webfetch", { url: "https://example.com" }, "builtin.webfetch.call"],
    ];

    for (const [toolName, input, expectedTemplateKey] of samples) {
      const display = buildToolCallDisplay(toolName, input);
      expect(display).toBeDefined();
      expect(display?.phase).toBe("call");
      expect(display?.toolName).toBe(toolName);
      expect(display?.templateKey).toBe(expectedTemplateKey);
    }
  });

  test("builds result displays for builtin tools", () => {
    const samples: Array<[string, unknown, unknown, string]> = [
      ["read", { filepath: "/tmp/a.txt" }, { size: 11, content: [[0, "hello"], [1, "world"]] }, "builtin.read.result"],
      ["write", { filepath: "/tmp/a.txt", content: "ok" }, { success: true, filepath: "/tmp/a.txt", bytes: 2, append: false }, "builtin.write.result"],
      ["ls", { dirpath: "/tmp/", long: false }, { dirpath: "/tmp/", command: "ls /tmp/", output: "a\nb\n" }, "builtin.ls.result"],
      ["tree", { dirpath: "/tmp/" }, { dirpath: "/tmp/", command: "tree /tmp/", output: "/tmp/\n`-- a\n1 directory, 1 file\n" }, "builtin.tree.result"],
      ["ripgrep", { dirpath: "/tmp/", pattern: "foo" }, { dirpath: "/tmp/", pattern: "foo", command: "rg foo /tmp/", output: "a.txt:1:foo\nb.txt:2:foo\n" }, "builtin.ripgrep.result"],
      ["cp", { source: "/tmp/a", destination: "/tmp/b" }, { success: true, source: "/tmp/a", destination: "/tmp/b", recursive: false, overwrite: false, method: "bun.fs" }, "builtin.cp.result"],
      ["mv", { source: "/tmp/a", destination: "/tmp/b" }, { success: true, source: "/tmp/a", destination: "/tmp/b", overwrite: false, method: "fs.rename" }, "builtin.mv.result"],
      ["git", { cwd: "/tmp", subcommand: "status" }, { success: true, cwd: "/tmp", command: "git status", stdout: "On branch main\n", stderr: "", exitCode: 0 }, "builtin.git.result"],
      ["bash", { action: "start", mode: "once", cwd: "/tmp", command: "pwd" }, { mode: "once", cwd: "/tmp", command: "pwd", success: true, exitCode: 0, stdout: "/tmp\n", stderr: "", durationMs: 12 }, "builtin.bash.once.result"],
      ["webfetch", { url: "https://example.com" }, "<html>Hello</html>", "builtin.webfetch.result"],
    ];

    for (const [toolName, input, result, expectedTemplateKey] of samples) {
      const display = buildToolResultDisplay(toolName, input, result);
      expect(display).toBeDefined();
      expect(display?.phase).toBe("result");
      expect(display?.toolName).toBe(toolName);
      expect(display?.templateKey).toBe(expectedTemplateKey);
    }
  });

  test("classifies bash session query and kill results into dedicated templates", () => {
    const queryDisplay = buildToolResultDisplay(
      "bash",
      { action: "query", sessionId: "s1" },
      {
        sessionId: "s1",
        mode: "normal",
        status: "running",
        cwd: "/tmp",
        command: "tail -f log",
        items: [{ seq: 1, stream: "stdout", text: "hello", at: Date.now() }],
        nextCursor: "abc",
        done: false,
      },
    );
    const killDisplay = buildToolResultDisplay(
      "bash",
      { action: "kill", sessionId: "s1" },
      {
        sessionId: "s1",
        mode: "normal",
        status: "killed",
        success: true,
        cwd: "/tmp",
        requestedAt: Date.now(),
        reason: "SIGTERM",
      },
    );

    expect(queryDisplay?.templateKey).toBe("builtin.bash.session_query.result");
    expect(killDisplay?.templateKey).toBe("builtin.bash.session_kill.result");
  });

  test("preserves key fields and truncates previews", () => {
    const largeText = Array.from({ length: 20 }, (_, index) => `line-${index} ${"x".repeat(200)}`).join("\n");
    const display = buildToolResultDisplay("webfetch", { url: "https://example.com" }, largeText);

    expect(getFieldValue(display, "url")).toBe("https://example.com");

    const previews = ((display?.data as Record<string, unknown>)?.previews ?? []) as Array<Record<string, unknown>>;
    expect(previews.length).toBeGreaterThan(0);
    const firstPreview = previews[0];
    const lines = Array.isArray(firstPreview?.lines) ? (firstPreview.lines as string[]) : [];
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]?.endsWith("...")).toBe(true);
    expect(firstPreview?.truncated).toBe(true);
  });

  test("returns error display with tool-specific template", () => {
    const display = buildToolResultDisplay(
      "read",
      { filepath: "/tmp/missing.txt" },
      { error: "The file is not exists, check filepath" },
      "The file is not exists, check filepath",
    );

    expect(display?.templateKey).toBe("builtin.read.result");
    expect(getFieldValue(display, "filepath")).toBe("/tmp/missing.txt");
    expect(getFieldValue(display, "error")).toContain("exists");
  });
});

