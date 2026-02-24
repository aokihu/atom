import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";
import type { LayoutMetrics, TerminalSize } from "../layout/metrics";
import { truncateToDisplayWidth } from "../utils/text";

export type StatusStripViewInput = {
  layout: LayoutMetrics;
  terminal: TerminalSize;
  rowWidth: number;
  mode?: "hybrid" | "tui" | "tui-client";
  connection: "unknown" | "ok" | "error";
  phase: "idle" | "submitting" | "polling";
  activeTaskId?: string;
  focus: "input" | "answer";
  serverUrl?: string;
  statusNotice: string;
};

export type StatusStripView = {
  box: BoxRenderable;
  rowTexts: [TextRenderable, TextRenderable];
};

export const createStatusStripView = (ctx: CliRenderer): StatusStripView => {
  const box = new BoxRenderable(ctx, {
    border: true,
    borderStyle: "single",
    borderColor: NORD.nord3,
    backgroundColor: NORD.nord0,
    paddingX: 1,
    width: "100%",
    flexDirection: "column",
  });
  const row1 = new TextRenderable(ctx, { content: " ", fg: NORD.nord4, width: "100%", truncate: true });
  const row2 = new TextRenderable(ctx, { content: " ", fg: NORD.nord3, width: "100%", truncate: true });
  box.add(row1);
  box.add(row2);

  return {
    box,
    rowTexts: [row1, row2],
  };
};

export const buildStatusStripRows = (input: StatusStripViewInput): string[] => {
  const displayMode = input.mode === "hybrid" ? "tui" : (input.mode ?? "tui");

  return [
    truncateToDisplayWidth(
      `mode:${displayMode}  term:${input.terminal.columns}x${input.terminal.rows}${input.serverUrl ? `  server:${input.serverUrl}` : ""}`,
      input.rowWidth,
    ),
  ].slice(0, input.layout.statusRows);
};
