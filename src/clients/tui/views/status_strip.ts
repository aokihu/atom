/**
 * TUI 组件：Status Strip（状态条）
 */
import { Box, Text, instantiate } from "@opentui/core";
import type { BoxRenderable, CliRenderer, MouseEvent, TextRenderable } from "@opentui/core";
import { effect, signal } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

import type { LayoutMetrics, TerminalSize } from "../layout/metrics";
import type { TuiTheme } from "../theme";
import { truncateToDisplayWidth } from "../utils/text";

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
  mcpConnected: number;
  mcpTotal: number;
  messageGatewayHealthAvailable: boolean;
  messageGatewayRunning: number;
  messageGatewayConfigured: number;
};

export type StatusStripView = {
  box: BoxRenderable;
  rowPrimary: BoxRenderable;
  leftText: TextRenderable;
  mcpTagText: TextRenderable;
  messageGatewayTagText: TextRenderable;
  rightText: TextRenderable;
  rowSecondary: TextRenderable;
};

export type StatusStripViewController = {
  readonly view: StatusStripView;
  syncFromAppState: (input: StatusStripViewInput) => void;
  dispose: () => void;
};

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

export const buildMcpTagLabel = (connected: number, total: number): string =>
  `[MCP Tools: ${connected}/${total}]`;

export const buildMessageGatewayTagLabel = (
  healthAvailable: boolean,
  running: number,
  configured: number,
): string =>
  healthAvailable ? `[Channels: ${running}/${configured}]` : "[Channels: off]";

export const isLeftMouseButton = (event: Pick<MouseEvent, "button">) => event.button === 0;

export const createMcpTagMouseUpHandler =
  (onMcpTagClick?: () => void) => (event: Pick<MouseEvent, "button">) => {
    if (isLeftMouseButton(event)) {
      onMcpTagClick?.();
    }
  };

export const createMessageGatewayTagMouseUpHandler =
  (onMessageGatewayTagClick?: () => void) => (event: Pick<MouseEvent, "button">) => {
    if (isLeftMouseButton(event)) {
      onMessageGatewayTagClick?.();
    }
  };

const buildStatusStripSegments = (input: StatusStripViewInput) => {
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

  const leftRaw = `${input.agentName}  Connect: ${connectLabel}  Status: ${statusLabel}`;
  return {
    left: truncateToDisplayWidth(leftRaw, Math.max(1, input.rowWidth)),
    mcp: buildMcpTagLabel(input.mcpConnected, input.mcpTotal),
    messageGateway: buildMessageGatewayTagLabel(
      input.messageGatewayHealthAvailable,
      input.messageGatewayRunning,
      input.messageGatewayConfigured,
    ),
    right: versionLabel,
  };
};

export const createStatusStripView = (
  args: {
    ctx: CliRenderer;
    theme: TuiTheme;
    onMcpTagClick?: () => void;
    onMessageGatewayTagClick?: () => void;
  },
): StatusStripView => {
  const C = args.theme.colors;
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
    Box(
      {
        width: "100%",
        flexDirection: "row",
        alignItems: "center",
      },
      Text({
        content: " ",
        fg: C.textSecondary,
        width: "100%",
        truncate: true,
        flexGrow: 1,
        flexShrink: 1,
      }),
      Text({
        content: " [MCP Tools: 0/0]",
        fg: C.accentPrimary,
        truncate: true,
        flexShrink: 0,
        onMouseUp: createMcpTagMouseUpHandler(args.onMcpTagClick),
      }),
      Text({
        content: " [Channels: off]",
        fg: C.accentSecondary,
        truncate: true,
        flexShrink: 0,
        onMouseUp: createMessageGatewayTagMouseUpHandler(args.onMessageGatewayTagClick),
      }),
      Text({
        content: " unknown",
        fg: C.textMuted,
        truncate: true,
        flexShrink: 0,
      }),
    ),
    Text({ content: " ", fg: C.textMuted, width: "100%", truncate: true }),
  );

  const box = instantiate(args.ctx, container) as unknown as BoxRenderable;
  const [rowPrimary, rowSecondary] = box.getChildren() as [BoxRenderable, TextRenderable];
  const [leftText, mcpTagText, messageGatewayTagText, rightText] = rowPrimary.getChildren() as [
    TextRenderable,
    TextRenderable,
    TextRenderable,
    TextRenderable,
  ];

  return {
    box,
    rowPrimary,
    leftText,
    mcpTagText,
    messageGatewayTagText,
    rightText,
    rowSecondary,
  };
};

export const updateStatusStripView = (
  view: StatusStripView,
  input: StatusStripViewInput,
): void => {
  view.box.visible = input.layout.showStatusStrip;
  view.box.height = input.layout.showStatusStrip ? input.layout.statusHeight : 0;
  view.rowPrimary.visible = input.layout.showStatusStrip && input.layout.statusRows >= 1;
  view.rowSecondary.visible = input.layout.showStatusStrip && input.layout.statusRows >= 2;

  const segments = buildStatusStripSegments(input);
  view.leftText.content = segments.left;
  view.mcpTagText.content = ` ${segments.mcp}`;
  view.messageGatewayTagText.content = ` ${segments.messageGateway}`;
  view.rightText.content = ` ${segments.right}`;
  view.rowSecondary.content = " ";
};

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

export const createStatusStripViewController = (
  args: {
    ctx: CliRenderer;
    theme: TuiTheme;
    onMcpTagClick?: () => void;
    onMessageGatewayTagClick?: () => void;
    isDestroyed?: () => boolean;
  },
): StatusStripViewController => {
  const view = createStatusStripView({
    ctx: args.ctx,
    theme: args.theme,
    onMcpTagClick: args.onMcpTagClick,
    onMessageGatewayTagClick: args.onMessageGatewayTagClick,
  });
  const inputSignal = signal<StatusStripViewInput | null>(null);
  const disposeSync = bindStatusStripViewModel({
    view,
    theme: args.theme,
    inputSignal,
    isDestroyed: args.isDestroyed,
  });

  return {
    view,
    syncFromAppState: (input) => {
      inputSignal.value = input;
    },
    dispose: () => {
      disposeSync();
    },
  };
};
