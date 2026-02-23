import { sleep } from "bun";
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";

import type { GatewayClient } from "../libs/channel/channel";
import { TaskStatus } from "../types/task";

type StartTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs?: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName?: string;
};

type ClientPhase = "idle" | "submitting" | "polling";
type ConnectionState = "unknown" | "ok" | "error";
type LogKind = "system" | "user" | "assistant" | "error" | "command";
type MainPanelKind = "empty" | "assistant" | "system" | "error";
type FocusTarget = "input" | "answer";
type LayoutMode = "full" | "compact" | "tiny";

type LogEntry = {
  id: number;
  kind: LogKind;
  text: string;
  createdAt: number;
};

type MainPanelContent = {
  kind: MainPanelKind;
  title: string;
  body: string;
  sourceLabel?: string;
};

type TerminalSize = {
  columns: number;
  rows: number;
};

type LayoutMetrics = {
  mode: LayoutMode;
  answerHeight: number;
  showEventStrip: boolean;
  eventStripHeight: number;
  eventRows: number;
  inputHeight: number;
  showInputHint: boolean;
  compactStatus: boolean;
};

type CoreTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName?: string;
};

const MAX_RENDER_ENTRIES = 200;
const MIN_TERMINAL_COLUMNS = 20;
const MIN_TERMINAL_ROWS = 8;
const ANSWER_PANEL_VERTICAL_OVERHEAD = 4; // border(2) + title(1) + status(1)
const PANEL_INNER_HORIZONTAL_OVERHEAD = 4; // border(2) + paddingX(2)
const ELLIPSIS = "...";
const DEFAULT_AGENT_NAME = "Atom";
const WAITING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const WAITING_SPINNER_INTERVAL_MS = 120;
const TEXTAREA_SUBMIT_KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "linefeed", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "linefeed", shift: true, action: "newline" as const },
  // Disable default Cmd+Enter submit when using textarea mode.
  { name: "return", meta: true, action: "newline" as const },
  { name: "linefeed", meta: true, action: "newline" as const },
];

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return `Failed to format JSON: ${formatErrorMessage(error)}`;
  }
};

const createInitialEntries = (): LogEntry[] => [
  {
    id: 1,
    kind: "system",
    text: "OpenTUI TUI ready. Type /help to see commands.",
    createdAt: Date.now(),
  },
];

const createInitialMainPanelContent = (agentName: string): MainPanelContent => ({
  kind: "empty",
  title: "Ready",
  sourceLabel: "startup",
  body: [
    `${agentName} TUI is ready.`,
    "",
    "Shortcuts:",
    "  Tab              Switch focus (Input / Answer)",
    "  Enter/Numpad     Submit when input is focused",
    "  Shift+Enter      New line in input",
    "  Ctrl+C           Exit",
    "",
    "Answer scrolling:",
    "  Use Scroll Area default keyboard/mouse behavior when Answer is focused.",
    "",
    "Slash commands:",
    "  /help  /messages  /context  /exit",
  ].join("\n"),
});

const getMainPanelColor = (kind: MainPanelKind): string => {
  switch (kind) {
    case "assistant":
      return "green";
    case "error":
      return "red";
    case "system":
      return "white";
    case "empty":
    default:
      return "gray";
  }
};

const helpText = [
  "Available commands:",
  "/help     Show this help",
  "/messages Show agent messages snapshot",
  "/context  Show agent context snapshot",
  "/exit     Exit TUI",
  "",
  "Shortcuts:",
  "Tab       Switch focus (Input / Answer)",
  "Enter     Submit when input is focused (main/numpad)",
  "Shift+Enter New line in input",
  "Ctrl+C    Exit",
  "",
  "Answer panel uses OpenTUI Scroll Area default scrolling when focused.",
].join("\n");

const toSafeNumber = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const isWideCodePoint = (codePoint: number): boolean => {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  );
};

const charDisplayWidth = (char: string): number => {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
};

const stringDisplayWidth = (value: string): number => {
  let width = 0;
  for (const char of Array.from(value)) {
    width += charDisplayWidth(char);
  }
  return width;
};

const truncateToDisplayWidth = (value: string, width: number): string => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth <= 0) return "";
  if (stringDisplayWidth(value) <= safeWidth) return value;
  if (safeWidth <= ELLIPSIS.length) return ELLIPSIS.slice(0, safeWidth);

  const targetWidth = safeWidth - ELLIPSIS.length;
  let current = "";
  let currentWidth = 0;

  for (const char of Array.from(value)) {
    const charWidth = charDisplayWidth(char);
    if (currentWidth + charWidth > targetWidth) break;
    current += char;
    currentWidth += charWidth;
  }

  return `${current}${ELLIPSIS}`;
};

const summarizeEventText = (text: string, maxWidth = 80): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(empty)";
  return truncateToDisplayWidth(singleLine, maxWidth);
};

const getTerminalSize = (renderer: CliRenderer): TerminalSize => ({
  columns: Math.max(MIN_TERMINAL_COLUMNS, toSafeNumber(renderer.terminalWidth || renderer.width, 80)),
  rows: Math.max(MIN_TERMINAL_ROWS, toSafeNumber(renderer.terminalHeight || renderer.height, 24)),
});

const getLayoutMetrics = (terminal: TerminalSize): LayoutMetrics => {
  const mode: LayoutMode = terminal.rows < 16 ? "tiny" : terminal.rows < 22 ? "compact" : "full";
  const showEventStrip = mode !== "tiny";
  const eventRows = mode === "full" ? 3 : mode === "compact" ? 1 : 0;
  const eventStripHeight = showEventStrip ? eventRows + 3 : 0; // border(2) + title(1) + rows
  const showInputHint = mode !== "tiny";
  const inputHeight = showInputHint ? 9 : 8; // border(2) + title + [hint] + 5-line textarea
  const reserved = eventStripHeight + inputHeight;
  const answerHeight = Math.max(5, terminal.rows - reserved);

  return {
    mode,
    answerHeight,
    showEventStrip,
    eventStripHeight,
    eventRows,
    inputHeight,
    showInputHint,
    compactStatus: terminal.columns < 50,
  };
};

const buildAnswerTitleLine = (
  mainPanel: MainPanelContent,
  headerWidth: number,
  agentName: string,
): string => {
  const source = mainPanel.sourceLabel ? ` | ${mainPanel.sourceLabel}` : "";
  const raw = `${agentName} Answer Zone | ${mainPanel.title}${source}`;
  return truncateToDisplayWidth(raw, headerWidth);
};

const buildAgentMetaLine = (props: {
  mainPanel: MainPanelContent;
  compact: boolean;
}): string => {
  const { mainPanel, compact } = props;
  const sourceText = mainPanel.sourceLabel
    ? truncateToDisplayWidth(mainPanel.sourceLabel, compact ? 12 : 20)
    : "-";

  if (compact) {
    return `type:${mainPanel.kind} src:${sourceText} scroll:scrollbox`;
  }

  return `type:${mainPanel.kind} source:${sourceText} scroll:scrollbox(default)`;
};

const getBusyIndicatorText = (phase: ClientPhase, agentName: string, frame: string): string => {
  if (phase === "submitting") {
    return `${frame} sending request`;
  }

  if (phase === "polling") {
    return `${frame} ${agentName} generating`;
  }

  return "";
};

class CoreTuiClientApp {
  private readonly client: GatewayClient;
  private readonly pollIntervalMs: number;
  private readonly serverUrl?: string;
  private readonly mode?: "hybrid" | "tui" | "tui-client";

  private destroyed = false;
  private terminal: TerminalSize;

  private entries: LogEntry[] = createInitialEntries();
  private nextLogId = 2;
  private agentName: string;
  private mainPanelContent: MainPanelContent;
  private phase: ClientPhase = "idle";
  private connection: ConnectionState = "unknown";
  private activeTaskId?: string;
  private focusTarget: FocusTarget = "input";
  private busySpinnerIndex = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;

  private readonly appRoot: BoxRenderable;
  private readonly answerBox: BoxRenderable;
  private readonly answerTitleText: TextRenderable;
  private readonly answerStatusText: TextRenderable;
  private readonly answerScroll: ScrollBoxRenderable;
  private readonly answerContentBox: BoxRenderable;
  private readonly answerBodyText: TextRenderable;

  private readonly statusBox: BoxRenderable;
  private readonly statusTitleText: TextRenderable;
  private readonly statusRowTexts: [TextRenderable, TextRenderable, TextRenderable];

  private readonly inputBox: BoxRenderable;
  private readonly inputTitleText: TextRenderable;
  private readonly inputHintText: TextRenderable;
  private readonly inputEditorHost: BoxRenderable;
  private readonly inputTextarea: TextareaRenderable;

  private readonly onResize = () => {
    if (this.destroyed) return;
    this.refreshAll();
  };

  private readonly onGlobalKeyPress = (key: KeyEvent) => {
    if (this.destroyed || key.eventType !== "press") {
      return;
    }

    if (key.name !== "tab") {
      return;
    }

    key.preventDefault();
    key.stopPropagation();

    if (this.isBusy()) {
      this.focusTarget = "answer";
    } else {
      this.focusTarget = this.focusTarget === "input" ? "answer" : "input";
    }

    this.syncFocus();
    this.syncStatusStrip();
    this.renderer.requestRender();
  };

  constructor(private readonly renderer: CliRenderer, options: CoreTuiClientOptions) {
    this.client = options.client;
    this.pollIntervalMs = options.pollIntervalMs;
    this.serverUrl = options.serverUrl;
    this.mode = options.mode;
    this.agentName = options.agentName?.trim() || DEFAULT_AGENT_NAME;
    this.mainPanelContent = createInitialMainPanelContent(this.agentName);
    this.terminal = getTerminalSize(renderer);

    const ctx = renderer;

    this.appRoot = new BoxRenderable(ctx, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });

    this.answerBox = new BoxRenderable(ctx, {
      border: true,
      borderStyle: "single",
      borderColor: "gray",
      paddingX: 1,
      flexDirection: "column",
      width: "100%",
    });
    this.answerTitleText = new TextRenderable(ctx, { content: "", fg: "cyan", width: "100%", truncate: true });
    this.answerStatusText = new TextRenderable(ctx, { content: "", fg: "gray", width: "100%", truncate: true });
    this.answerScroll = new ScrollBoxRenderable(ctx, {
      width: "100%",
      height: 1,
      scrollX: false,
      scrollY: true,
    });
    this.answerContentBox = new BoxRenderable(ctx, { width: "100%" });
    this.answerBodyText = new TextRenderable(ctx, {
      content: " ",
      fg: "gray",
      width: "100%",
      wrapMode: "char",
    });
    this.answerContentBox.add(this.answerBodyText);
    this.answerScroll.add(this.answerContentBox);
    this.answerBox.add(this.answerTitleText);
    this.answerBox.add(this.answerStatusText);
    this.answerBox.add(this.answerScroll);

    this.statusBox = new BoxRenderable(ctx, {
      border: true,
      borderStyle: "single",
      borderColor: "gray",
      paddingX: 1,
      flexDirection: "column",
      width: "100%",
    });
    this.statusTitleText = new TextRenderable(ctx, { content: "System Status", fg: "cyan", width: "100%" });
    const statusRow1 = new TextRenderable(ctx, { content: " ", fg: "gray", width: "100%", truncate: true });
    const statusRow2 = new TextRenderable(ctx, { content: " ", fg: "gray", width: "100%", truncate: true });
    const statusRow3 = new TextRenderable(ctx, { content: " ", fg: "gray", width: "100%", truncate: true });
    this.statusRowTexts = [statusRow1, statusRow2, statusRow3];
    this.statusBox.add(this.statusTitleText);
    this.statusBox.add(statusRow1);
    this.statusBox.add(statusRow2);
    this.statusBox.add(statusRow3);

    this.inputBox = new BoxRenderable(ctx, {
      border: true,
      borderStyle: "single",
      borderColor: "gray",
      paddingX: 1,
      flexDirection: "column",
      width: "100%",
    });
    this.inputTitleText = new TextRenderable(ctx, { content: "User Input Zone", fg: "cyan", width: "100%" });
    this.inputHintText = new TextRenderable(ctx, { content: "", fg: "gray", width: "100%", truncate: true });
    this.inputEditorHost = new BoxRenderable(ctx, {
      width: "100%",
      height: 1,
    });
    this.inputTextarea = new TextareaRenderable(ctx, {
      width: "100%",
      height: "100%",
      initialValue: "",
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      wrapMode: "word",
      keyBindings: TEXTAREA_SUBMIT_KEY_BINDINGS,
      onSubmit: () => {
        if (this.handleSubmit(this.inputTextarea.plainText)) {
          this.inputTextarea.replaceText("");
        }
      },
    });
    this.inputEditorHost.add(this.inputTextarea);
    this.inputBox.add(this.inputTitleText);
    this.inputBox.add(this.inputHintText);
    this.inputBox.add(this.inputEditorHost);

    this.appRoot.add(this.answerBox);
    this.appRoot.add(this.statusBox);
    this.appRoot.add(this.inputBox);
    this.renderer.root.add(this.appRoot);

    this.renderer.on("resize", this.onResize);
    this.renderer._internalKeyInput.onInternal("keypress", this.onGlobalKeyPress);

    this.refreshAll();
    void this.bootstrapHealthCheck();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.stopSpinner();

    try {
      this.renderer.off("resize", this.onResize);
    } catch {
      // noop
    }

    try {
      this.renderer._internalKeyInput.offInternal("keypress", this.onGlobalKeyPress);
    } catch {
      // noop
    }

    try {
      this.renderer.root.remove(this.appRoot.id);
    } catch {
      // Root may already be torn down by renderer.destroy().
    }

    if (!this.appRoot.isDestroyed) {
      this.appRoot.destroyRecursively();
    }
  }

  private isBusy(): boolean {
    return this.phase !== "idle";
  }

  private getEffectiveFocus(): FocusTarget {
    return this.isBusy() ? "answer" : this.focusTarget;
  }

  private getBusyIndicator(): string | undefined {
    if (this.phase === "idle") {
      return undefined;
    }

    return getBusyIndicatorText(
      this.phase,
      this.agentName,
      WAITING_SPINNER_FRAMES[this.busySpinnerIndex] ?? WAITING_SPINNER_FRAMES[0],
    );
  }

  private getLayout(): LayoutMetrics {
    return getLayoutMetrics(this.terminal);
  }

  private updateTerminalSize(): void {
    this.terminal = getTerminalSize(this.renderer);
  }

  private refreshAll(): void {
    if (this.destroyed) return;

    this.updateTerminalSize();
    const layout = this.getLayout();

    this.appRoot.width = "100%";
    this.appRoot.height = "100%";

    this.syncAnswerPane(layout);
    this.syncStatusStrip(layout);
    this.syncInputPane(layout);
    this.syncFocus();

    this.renderer.requestRender();
  }

  private syncAnswerPane(layout: LayoutMetrics): void {
    const effectiveFocus = this.getEffectiveFocus();
    const busyIndicator = this.getBusyIndicator();
    const headerWidth = Math.max(1, this.terminal.columns - PANEL_INNER_HORIZONTAL_OVERHEAD);
    const titleLine = buildAnswerTitleLine(this.mainPanelContent, headerWidth, this.agentName);
    const baseStatusLine = truncateToDisplayWidth(
      buildAgentMetaLine({
        mainPanel: this.mainPanelContent,
        compact: this.terminal.columns < 50,
      }),
      headerWidth,
    );
    const statusLine = busyIndicator
      ? truncateToDisplayWidth(`${baseStatusLine}  ${busyIndicator}`, headerWidth)
      : baseStatusLine;
    const contentColor = getMainPanelColor(this.mainPanelContent.kind);
    const scrollAreaHeight = Math.max(1, layout.answerHeight - ANSWER_PANEL_VERTICAL_OVERHEAD);

    this.answerBox.height = layout.answerHeight;
    this.answerBox.borderColor = effectiveFocus === "answer" ? "cyan" : "gray";
    this.answerTitleText.content = titleLine || `${this.agentName} Answer Zone`;
    this.answerStatusText.content = statusLine || "status unavailable";
    this.answerScroll.height = scrollAreaHeight;
    this.answerBodyText.fg = this.mainPanelContent.kind === "empty" ? "gray" : contentColor;
    this.answerBodyText.content = this.mainPanelContent.body.length > 0 ? this.mainPanelContent.body : " ";
  }

  private syncStatusStrip(layout?: LayoutMetrics): void {
    const activeLayout = layout ?? this.getLayout();
    const rowWidth = Math.max(1, this.terminal.columns - PANEL_INNER_HORIZONTAL_OVERHEAD);
    const effectiveFocus = this.getEffectiveFocus();
    const displayMode = this.mode === "hybrid" ? "tui" : (this.mode ?? "tui");

    this.statusBox.visible = activeLayout.showEventStrip;
    this.statusBox.height = activeLayout.showEventStrip ? activeLayout.eventStripHeight : 0;

    const rows = [
      `mode:${displayMode}  layout:${activeLayout.mode}  conn:${this.connection}  state:${this.phase}`,
      `server:${this.serverUrl ?? "(unknown)"}${this.activeTaskId ? `  task:${this.activeTaskId}` : ""}`,
      `term:${this.terminal.columns}x${this.terminal.rows}  focus:${effectiveFocus}  scroll:scrollbox`,
      `panel:${this.mainPanelContent.kind}  title:${this.mainPanelContent.title}${this.mainPanelContent.sourceLabel ? `  src:${this.mainPanelContent.sourceLabel}` : ""}`,
    ]
      .slice(0, Math.max(0, activeLayout.eventRows))
      .map((line) => truncateToDisplayWidth(line, rowWidth));

    for (let index = 0; index < this.statusRowTexts.length; index += 1) {
      const rowText = this.statusRowTexts[index]!;
      const line = rows[index];
      rowText.visible = activeLayout.showEventStrip;
      rowText.content = line && line.length > 0 ? line : " ";
    }
  }

  private syncInputPane(layout: LayoutMetrics): void {
    const effectiveFocus = this.getEffectiveFocus();
    const inputFocused = !this.isBusy() && effectiveFocus === "input";
    const busyIndicator = this.getBusyIndicator();
    const editorHeight = Math.max(1, layout.inputHeight - (layout.showInputHint ? 4 : 3));
    const placeholderText = this.isBusy()
      ? busyIndicator ?? "Waiting for task completion..."
      : `Ask ${this.agentName} or type /help (Shift+Enter for newline)`;

    this.inputBox.height = layout.inputHeight;
    this.inputBox.borderColor = inputFocused ? "cyan" : "gray";

    this.inputHintText.visible = layout.showInputHint;
    this.inputHintText.content = layout.showInputHint
      ? this.isBusy()
        ? `${busyIndicator ?? "Task in progress..."} input locked; switch to answer to scroll.`
        : "Enter submit, Shift+Enter newline. Tab switches focus."
      : " ";

    this.inputEditorHost.height = editorHeight;
    this.inputTextarea.height = "100%";
    this.inputTextarea.width = "100%";
    this.inputTextarea.placeholder = placeholderText;
  }

  private syncFocus(): void {
    const effectiveFocus = this.getEffectiveFocus();
    const inputFocused = !this.isBusy() && effectiveFocus === "input";

    if (inputFocused) {
      this.inputTextarea.focus();
      this.answerScroll.blur();
    } else {
      this.inputTextarea.blur();
      this.answerScroll.focus();
    }
  }

  private appendLog(kind: LogKind, text: string): void {
    if (this.destroyed) return;

    const nextEntry: LogEntry = {
      id: this.nextLogId++,
      kind,
      text,
      createdAt: Date.now(),
    };

    const next = [...this.entries, nextEntry];
    this.entries = next.length > MAX_RENDER_ENTRIES ? next.slice(-MAX_RENDER_ENTRIES) : next;
  }

  private setMainPanelContent(next: MainPanelContent): void {
    if (this.destroyed) return;
    this.mainPanelContent = next;
    this.refreshAll();
  }

  private setClientPhase(nextPhase: ClientPhase): void {
    if (this.destroyed) return;

    this.phase = nextPhase;
    if (this.isBusy() && this.focusTarget !== "answer") {
      this.focusTarget = "answer";
    }

    if (nextPhase === "idle") {
      this.busySpinnerIndex = 0;
      this.stopSpinner();
    } else {
      this.startSpinner();
    }

    this.refreshAll();
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;

    this.spinnerTimer = setInterval(() => {
      if (this.destroyed || !this.isBusy()) {
        this.stopSpinner();
        return;
      }

      this.busySpinnerIndex = (this.busySpinnerIndex + 1) % WAITING_SPINNER_FRAMES.length;
      this.refreshAll();
    }, WAITING_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private markConnected(): void {
    if (this.destroyed) return;
    this.connection = "ok";
    this.syncStatusStrip();
    this.renderer.requestRender();
  }

  private markDisconnected(): void {
    if (this.destroyed) return;
    this.connection = "error";
    this.syncStatusStrip();
    this.renderer.requestRender();
  }

  private setTaskId(taskId?: string): void {
    if (this.destroyed) return;
    this.activeTaskId = taskId;
    this.syncStatusStrip();
    this.renderer.requestRender();
  }

  private async withConnectionTracking<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      this.markConnected();
      return result;
    } catch (error) {
      this.markDisconnected();
      throw error;
    }
  }

  private async bootstrapHealthCheck(): Promise<void> {
    try {
      const health = await this.withConnectionTracking(() => this.client.getHealth());
      const remoteAgentName = health.name?.trim();
      if (!remoteAgentName || this.destroyed) {
        return;
      }

      this.agentName = remoteAgentName;
      if (this.mainPanelContent.kind === "empty" && this.mainPanelContent.sourceLabel === "startup") {
        this.mainPanelContent = createInitialMainPanelContent(this.agentName);
      }
      this.refreshAll();
    } catch {
      // Keep startup non-blocking; errors are surfaced on demand.
    }
  }

  private presentError(title: string, errorText: string, sourceLabel?: string): void {
    this.setMainPanelContent({
      kind: "error",
      title,
      body: errorText,
      sourceLabel,
    });
  }

  private async runSlashCommand(command: string): Promise<void> {
    this.appendLog("command", command);

    if (command === "/help") {
      this.setMainPanelContent({
        kind: "system",
        title: "Help",
        body: helpText,
        sourceLabel: command,
      });
      this.appendLog("system", "Help displayed");
      return;
    }

    if (command === "/exit") {
      this.renderer.destroy();
      return;
    }

    if (command !== "/messages" && command !== "/context") {
      const message = `Unknown command: ${command}`;
      this.appendLog("error", message);
      this.presentError("Command Error", message, command);
      return;
    }

    if (this.phase !== "idle") {
      const message = "A task is already running. Please wait.";
      this.appendLog("error", message);
      this.presentError("Busy", message, command);
      return;
    }

    this.setClientPhase("submitting");
    this.setTaskId(undefined);

    try {
      if (command === "/messages") {
        const data = await this.withConnectionTracking(() => this.client.getAgentMessages());
        const body = formatJson(data.messages);
        this.setMainPanelContent({
          kind: "system",
          title: "Agent Messages Snapshot",
          body,
          sourceLabel: command,
        });
        this.appendLog("system", `/messages loaded (${data.messages.length} messages)`);
      } else {
        const data = await this.withConnectionTracking(() => this.client.getAgentContext());
        const body = formatJson(data.context);
        this.setMainPanelContent({
          kind: "system",
          title: "Agent Context Snapshot",
          body,
          sourceLabel: command,
        });
        this.appendLog("system", "/context loaded");
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      this.appendLog("error", summarizeEventText(`${command} failed: ${message}`));
      this.presentError("Command Error", `${command}\n\n${message}`, command);
    } finally {
      this.setClientPhase("idle");
    }
  }

  private async runPromptTask(question: string): Promise<void> {
    if (this.phase !== "idle") {
      const message = "A task is already running. Please wait.";
      this.appendLog("error", message);
      this.presentError("Busy", message, "submit");
      return;
    }

    this.appendLog("user", question);
    this.setClientPhase("submitting");
    this.setTaskId(undefined);
    this.setMainPanelContent({
      kind: "system",
      title: "Generating Reply",
      body: `Submitting request...\n\nWaiting for ${this.agentName} to generate a response.`,
      sourceLabel: "submit",
    });

    try {
      const created = await this.withConnectionTracking(() =>
        this.client.createTask({
          type: "tui.input",
          input: question,
        }),
      );

      if (this.destroyed) return;

      this.setTaskId(created.taskId);
      this.appendLog("system", `Task created: ${created.taskId}`);
      this.setMainPanelContent({
        kind: "system",
        title: "Generating Reply",
        body: `Request accepted.\n\n${this.agentName} is generating a response...\nTask: ${created.taskId}`,
        sourceLabel: created.taskId,
      });
      this.setClientPhase("polling");

      while (!this.destroyed) {
        const status = await this.withConnectionTracking(() => this.client.getTask(created.taskId));
        const task = status.task;

        if (task.status === TaskStatus.Pending || task.status === TaskStatus.Running) {
          await sleep(this.pollIntervalMs);
          continue;
        }

        if (task.status === TaskStatus.Success) {
          if (task.result !== undefined) {
            this.setMainPanelContent({
              kind: "assistant",
              title: "Latest Reply",
              body: task.result,
              sourceLabel: created.taskId,
            });
            this.appendLog("assistant", `Reply received (${task.result.length} chars)`);
          } else {
            const message = "Task succeeded with empty result.";
            this.setMainPanelContent({
              kind: "system",
              title: "Empty Result",
              body: message,
              sourceLabel: created.taskId,
            });
            this.appendLog("system", message);
          }
        } else if (task.status === TaskStatus.Failed) {
          const message = task.error?.message ?? "Unknown error";
          this.appendLog("error", `Task failed: ${message}`);
          this.presentError("Task Failed", `${created.taskId}\n\n${message}`, created.taskId);
        } else if (task.status === TaskStatus.Cancelled) {
          const message = "Task was cancelled.";
          this.appendLog("system", message);
          this.setMainPanelContent({
            kind: "system",
            title: "Task Cancelled",
            body: `${created.taskId}\n\n${message}`,
            sourceLabel: created.taskId,
          });
        } else {
          const message = `Task completed with unexpected status: ${task.status}`;
          this.appendLog("system", message);
          this.setMainPanelContent({
            kind: "system",
            title: "Task Completed",
            body: `${created.taskId}\n\n${message}`,
            sourceLabel: created.taskId,
          });
        }

        break;
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      this.appendLog("error", `Request failed: ${message}`);
      this.presentError("Request Error", message, "submit");
    } finally {
      this.setTaskId(undefined);
      this.setClientPhase("idle");
    }
  }

  private handleSubmit(rawValue: string): boolean {
    if (this.destroyed || this.phase !== "idle" || this.getEffectiveFocus() !== "input") {
      return false;
    }

    const submitValue = rawValue.replace(/\r?\n$/, "");
    const trimmedValue = submitValue.trim();

    if (!trimmedValue) {
      return true;
    }

    if (!submitValue.includes("\n") && trimmedValue.startsWith("/")) {
      void this.runSlashCommand(trimmedValue);
      return true;
    }

    void this.runPromptTask(submitValue);
    return true;
  }
}

export const startTuiClient = async (options: StartTuiClientOptions): Promise<void> => {
  const { client, pollIntervalMs = 500, serverUrl, mode, agentName } = options;

  let resolveExit: (() => void) | undefined;
  const waitForExit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    onDestroy: () => {
      resolveExit?.();
    },
  });

  let app: CoreTuiClientApp | undefined;

  try {
    app = new CoreTuiClientApp(renderer, {
      client,
      pollIntervalMs,
      serverUrl,
      mode,
      agentName,
    });

    await waitForExit;
  } catch (error) {
    renderer.destroy();
    throw error;
  } finally {
    app?.destroy();
  }
};
