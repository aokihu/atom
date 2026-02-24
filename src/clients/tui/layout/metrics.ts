import type { CliRenderer } from "@opentui/core";

export type LayoutMode = "full" | "compact" | "tiny";

export type TerminalSize = {
  columns: number;
  rows: number;
};

export type LayoutMetrics = {
  mode: LayoutMode;
  messageHeight: number;
  showStatusStrip: boolean;
  statusHeight: number;
  statusRows: number;
  inputHeight: number;
  inputHintHeight: number;
  railWidth: number;
  compactStatus: boolean;
};

const MIN_TERMINAL_COLUMNS = 20;
const MIN_TERMINAL_ROWS = 8;
const STATUS_PANEL_VERTICAL_OVERHEAD = 2;
const INPUT_PANEL_VERTICAL_OVERHEAD = 2;
const INPUT_EDITOR_ROWS = 5;

const toSafeNumber = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export const getTerminalSize = (renderer: CliRenderer): TerminalSize => ({
  columns: Math.max(MIN_TERMINAL_COLUMNS, toSafeNumber(renderer.terminalWidth || renderer.width, 80)),
  rows: Math.max(MIN_TERMINAL_ROWS, toSafeNumber(renderer.terminalHeight || renderer.height, 24)),
});

export const getLayoutMetrics = (terminal: TerminalSize): LayoutMetrics => {
  const mode: LayoutMode = terminal.rows < 16 ? "tiny" : terminal.rows < 24 ? "compact" : "full";
  const showStatusStrip = mode !== "tiny";
  const statusRows = mode === "full" ? 2 : 1;
  const statusHeight = showStatusStrip ? STATUS_PANEL_VERTICAL_OVERHEAD + statusRows : 0;
  const inputHintHeight = 1;
  const inputHeight = INPUT_PANEL_VERTICAL_OVERHEAD + inputHintHeight + INPUT_EDITOR_ROWS;
  const reserved = statusHeight + inputHeight;
  const messageHeight = Math.max(5, terminal.rows - reserved);
  const railWidth = 2;

  return {
    mode,
    messageHeight,
    showStatusStrip,
    statusHeight,
    statusRows,
    inputHeight,
    inputHintHeight,
    railWidth,
    compactStatus: terminal.columns < 54,
  };
};
