import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";
import type { LayoutMetrics, TerminalSize } from "../layout/metrics";
import { stringDisplayWidth, truncateToDisplayWidth } from "../utils/text";

export type StatusStripViewInput = {
  layout: LayoutMetrics;
  terminal: TerminalSize;
  rowWidth: number;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName: string;
  version?: string;
  connection: "unknown" | "ok" | "error";
  phase: "idle" | "submitting" | "polling";
  spinnerFrame?: string;
  busyAnimationTick?: number;
  activeTaskId?: string;
  serverUrl?: string;
  statusNotice: string;
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cumulative_total_tokens?: number;
  };
};

export type StatusStripView = {
  box: BoxRenderable;
  rowTexts: [TextRenderable, TextRenderable];
};

const buildSweepBar = (tick = 0, width = 12): string => {
  const normalizedWidth = Math.max(6, width);
  const period = normalizedWidth + 6;
  const center = (tick % period) - 3; // start off-screen, sweep through, then off-screen

  let bar = "";
  for (let i = 0; i < normalizedWidth; i += 1) {
    const distance = Math.abs(i - center);
    if (distance === 0) {
      bar += "#";
    } else if (distance === 1) {
      bar += "=";
    } else if (distance === 2) {
      bar += "-";
    } else {
      bar += ".";
    }
  }

  return bar;
};

const buildBusyStatusPill = (
  phase: "submitting" | "polling",
  spinnerFrame?: string,
  busyAnimationTick?: number,
): string => {
  const label = phase === "submitting" ? "Submitting" : "Working";
  const tickBase = (busyAnimationTick ?? 0) * 2;
  const frameNudge: Record<string, number> = {
    "-": 0,
    "\\": 1,
    "|": 2,
    "/": 3,
  };
  const tick = tickBase + (frameNudge[spinnerFrame ?? ""] ?? 0);
  const sweep = buildSweepBar(tick, phase === "submitting" ? 10 : 12);
  return `[${label} ${sweep}]`;
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
  const connectLabel =
    input.connection === "ok" ? "OK" : input.connection === "error" ? "ERROR" : "UNKNOWN";
  const statusLabel =
    input.phase === "idle"
      ? "Idle"
      : buildBusyStatusPill(
          input.phase === "submitting" ? "submitting" : "polling",
          input.spinnerFrame,
          input.busyAnimationTick,
        );
  const versionLabel = (input.version?.trim() || "unknown").replace(/\s+/g, " ");
  const tokenLabel = input.tokenUsage
    ? `TOK in:${input.tokenUsage.input_tokens} out:${input.tokenUsage.output_tokens} total:${input.tokenUsage.total_tokens}${
        typeof input.tokenUsage.cumulative_total_tokens === "number"
          ? ` cum:${input.tokenUsage.cumulative_total_tokens}`
          : ""
      }`
    : "TOK n/a";

  const left = `${input.agentName}  Connect: ${connectLabel}  Status: ${statusLabel}  ${tokenLabel}`;
  const right = versionLabel;
  const fillerWidth = input.rowWidth - stringDisplayWidth(left) - stringDisplayWidth(right);

  const line =
    fillerWidth >= 2
      ? `${left}${" ".repeat(fillerWidth)}${right}`
      : `${left}  ${right}`;

  return [
    truncateToDisplayWidth(line, input.rowWidth),
  ].slice(0, input.layout.statusRows);
};
