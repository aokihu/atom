/**
 * TUI 组件：Status Strip（状态条）
 * 用于何处：被 `src/clients/tui/runtime/ui.ts` 装配在消息区与输入区之间，由 `CoreTuiClientApp` 刷新连接状态/工作状态文案。
 * 主要职责：构建状态条节点树，并根据运行状态生成一行或多行状态文本内容。
 *
 * ASCII Layout
 * +-------------------------------------------------------------------+
 * | row1: agent / connect / status / version                     |
 * | row2: reserved secondary line (optional by layout rows)      |
 * +-------------------------------------------------------------------+
 */
import { Box, Text, instantiate } from "@opentui/core";
import type { BoxRenderable, CliRenderer, TextRenderable } from "@opentui/core";
import { effect } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

import type { LayoutMetrics, TerminalSize } from "../layout/metrics";
import type { TuiTheme } from "../theme";
import { stringDisplayWidth, truncateToDisplayWidth } from "../utils/text";

// ================================
// 类型定义区
// ================================

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
};

export type StatusStripView = {
  box: BoxRenderable;
  rowTexts: [TextRenderable, TextRenderable];
};

// ================================
// 逻辑计算区（状态文案）
// ================================

const buildSweepBar = (tick = 0, width = 12): string => {
  const normalizedWidth = Math.max(6, width);
  const period = normalizedWidth + 6;
  const center = (tick % period) - 3;

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

  const left = `${input.agentName}  Connect: ${connectLabel}  Status: ${statusLabel}`;
  const right = versionLabel;
  const fillerWidth = input.rowWidth - stringDisplayWidth(left) - stringDisplayWidth(right);

  const line =
    fillerWidth >= 2
      ? `${left}${" ".repeat(fillerWidth)}${right}`
      : `${left}  ${right}`;

  return [truncateToDisplayWidth(line, input.rowWidth)].slice(0, input.layout.statusRows);
};

// ================================
// UI 渲染区（Constructs 节点树）
// ================================

export const createStatusStripView = (ctx: CliRenderer, theme: TuiTheme): StatusStripView => {
  const C = theme.colors;
  // 部件说明：状态条根容器（边框 + 双行文本），使用先构建 VNode 再实例化的 Constructs 风格。
  const container = Box(
    {
      border: true,
      borderStyle: "single",
      borderColor: C.borderDefault,
      backgroundColor: C.panelBackground,
      paddingX: 1,
      width: "100%",
      flexDirection: "column",
    },
    Text({ content: " ", fg: C.textSecondary, width: "100%", truncate: true }),
    Text({ content: " ", fg: C.textMuted, width: "100%", truncate: true }),
  );

  const box = instantiate(ctx, container) as unknown as BoxRenderable;

  // 部件说明：第 1 行显示主状态；第 2 行预留为辅助状态行（当前通常为空）。
  const [row1, row2] = box.getChildren() as [TextRenderable, TextRenderable];
  const view: StatusStripView = {
    box,
    rowTexts: [row1, row2],
  };

  return view;
};

// ================================
// 运行时注入区（将实时状态数据注入组件）
// ================================

export const updateStatusStripView = (
  view: StatusStripView,
  input: StatusStripViewInput,
): void => {
  view.box.visible = input.layout.showStatusStrip;
  view.box.height = input.layout.showStatusStrip ? input.layout.statusHeight : 0;

  const rows = buildStatusStripRows(input);
  for (let index = 0; index < view.rowTexts.length; index += 1) {
    const rowText = view.rowTexts[index]!;
    rowText.visible = input.layout.showStatusStrip && index < input.layout.statusRows;
    rowText.content = rows[index] && rows[index]!.length > 0 ? rows[index]! : " ";
  }
};

// ================================
// 响应式绑定区（Signal -> 视图同步）
// ================================

export const bindStatusStripViewModel = (
  args: {
    view: StatusStripView;
    theme: TuiTheme;
    inputSignal: ReadonlySignal<StatusStripViewInput | null>;
    isDestroyed?: () => boolean;
  },
): (() => void) => effect(() => {
  if (args.isDestroyed?.()) return;
  const input = args.inputSignal.value;
  if (!input) return;

  args.view.box.borderColor = args.theme.colors.borderDefault;
  updateStatusStripView(args.view, input);
});
