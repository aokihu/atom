import { describe, expect, test } from "bun:test";

import type { ToolDisplayEnvelope } from "../../../types/http";
import {
  buildToolCardCollapsedSummary,
  buildToolCardStyledLines,
  renderToolCardBody,
} from "./tool_templates";

const makeDisplay = (args: Partial<ToolDisplayEnvelope> & Pick<ToolDisplayEnvelope, "templateKey" | "toolName" | "phase">): ToolDisplayEnvelope => ({
  version: 1,
  data: {
    summary: "Example summary",
    fields: [
      { label: "filepath", value: "/tmp/demo.txt" },
      { label: "append", value: "no" },
    ],
    previews: [
      { title: "Preview", lines: ["0: hello", "1: world"], truncated: true },
    ],
  },
  ...args,
});

describe("tool template rendering", () => {
  test("renders structured builtin display", () => {
    const body = renderToolCardBody({
      toolName: "read",
      status: "done",
      resultDisplay: makeDisplay({
        toolName: "read",
        phase: "result",
        templateKey: "builtin.read.result",
      }),
      resultSummary: "{\"size\":11}",
    });

    expect(body).toContain("Summary: Example summary");
    expect(body).toContain("filepath: /tmp/demo.txt");
    expect(body).toContain("Preview:");
    expect(body).toContain("  0: hello");
    expect(body).toContain("  ...");
  });

  test("uses call display while running", () => {
    const body = renderToolCardBody({
      toolName: "ls",
      status: "running",
      callSummary: "{\"dirpath\":\"/tmp/\"}",
      callDisplay: makeDisplay({
        toolName: "ls",
        phase: "call",
        templateKey: "builtin.ls.call",
      }),
    });

    expect(body).toContain("Summary:");
    expect(body).not.toContain("Running...");
  });

  test("falls back to generic result summary when display is missing", () => {
    const body = renderToolCardBody({
      toolName: "memory:search",
      status: "done",
      resultSummary: "{\"items\":[]}",
    });

    expect(body).toBe("{\"items\":[]}");
  });

  test("falls back when template key is unknown", () => {
    const body = renderToolCardBody({
      toolName: "custom",
      status: "error",
      errorMessage: "boom",
      resultDisplay: makeDisplay({
        toolName: "custom",
        phase: "result",
        templateKey: "custom.unknown",
      }),
      resultSummary: "{\"error\":\"boom\"}",
    });

    expect(body).toContain("error: boom");
    expect(body).toContain("{\"error\":\"boom\"}");
  });

  test("marks error fields and preview streams with semantic tones", () => {
    const lines = buildToolCardStyledLines({
      toolName: "git",
      status: "error",
      resultDisplay: {
        version: 1,
        toolName: "git",
        phase: "result",
        templateKey: "builtin.git.result",
        data: {
          summary: "Git command failed",
          fields: [
            { label: "cwd", value: "/tmp/repo" },
            { label: "error", value: "fatal: not a git repository" },
          ],
          previews: [
            { title: "stderr", lines: ["fatal: not a git repository"], truncated: false },
          ],
        },
      },
    });

    const errorField = lines.find((line) => line.kind === "field" && line.label === "error");
    const stderrPreviewLine = lines.find((line) => line.kind === "previewLine" && line.text.includes("fatal"));

    expect(errorField && errorField.kind === "field" ? errorField.tone : undefined).toBe("error");
    expect(stderrPreviewLine && stderrPreviewLine.kind === "previewLine" ? stderrPreviewLine.tone : undefined)
      .toBe("stderr");
  });

  test("includes ls params in collapsed summary", () => {
    const collapsed = buildToolCardCollapsedSummary({
      toolName: "ls",
      status: "done",
      callDisplay: {
        version: 1,
        toolName: "ls",
        phase: "call",
        templateKey: "builtin.ls.call",
        data: {
          fields: [
            { label: "dirpath", value: "/tmp/demo" },
            { label: "all", value: "yes" },
            { label: "long", value: "no" },
          ],
        },
      },
      resultDisplay: {
        version: 1,
        toolName: "ls",
        phase: "result",
        templateKey: "builtin.ls.result",
        data: {
          fields: [{ label: "entryCount", value: "12" }],
        },
      },
    });

    expect(collapsed).toContain("dir=/tmp/demo");
    expect(collapsed).toContain("all=yes");
    expect(collapsed).toContain("long=no");
  });
});
