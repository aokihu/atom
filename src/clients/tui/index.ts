import { sleep } from "bun";
import {
  BoxRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";

import type { GatewayClient } from "../../libs/channel/channel";
import type { AgentContextResponse, TaskOutputMessage } from "../../types/http";
import { TaskStatus, isTaskExecutionStopReason } from "../../types/task";
import { resolveSlashCommandAction } from "./controllers/commands";
import { executeContextCommand } from "./controllers/context_command";
import { executePromptTaskFlow } from "./flows/prompt_task";
import {
  getLayoutMetrics,
  getTerminalSize,
  type LayoutMetrics,
} from "./layout/metrics";
import {
  type ChatMessageRole,
  type ClientPhase,
  type ConnectionState,
  type FocusTarget,
  type LogKind,
  type SlashModalState,
  TuiClientState,
} from "./runtime/state";
import { createTuiClientUiBundle, type TuiClientUiBundle } from "./runtime/ui";
import { filterEnabledSlashCommands, type SlashCommandOption } from "./state/slash_commands";
import { NORD } from "./theme/nord";
import { summarizeEventText, truncateToDisplayWidth } from "./utils/text";
import { buildContextLogPayload, saveContextLog } from "./utils/context_log";
import { buildContextModalLayoutState } from "./views/context_modal";
import { buildInputPaneViewState } from "./views/input_pane";
import {
  buildMessageHeaderLine,
  buildMessageSubHeaderLine,
  renderMessageStreamContent,
} from "./views/message_pane";
import { buildSlashModalLayoutState } from "./views/slash_modal";
import { buildStatusStripRows } from "./views/status_strip";

type StartTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs?: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName?: string;
};

type CoreTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName?: string;
};

const PANEL_INNER_HORIZONTAL_OVERHEAD = 4; // border(2) + paddingX(2)
const MESSAGE_PANEL_VERTICAL_OVERHEAD = 3; // top inset + header row + divider row
const INPUT_EDITOR_ROWS = 5;
const DEFAULT_AGENT_NAME = "Atom";
const WAITING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const WAITING_SPINNER_INTERVAL_MS = 120;
const CTRL_C_EXIT_CONFIRM_MS = 1500;
const TEXTAREA_SUBMIT_KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "linefeed", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "linefeed", shift: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "linefeed", meta: true, action: "newline" as const },
];
const INPUT_RAIL_GLYPH_CHAR = "▎";
const INPUT_RAIL_INNER_VERTICAL_PADDING = 2;
const buildInputRailGlyphContent = (height: number): string => {
  const lines = Math.max(1, Math.floor(height));
  return Array.from({ length: lines }, () => INPUT_RAIL_GLYPH_CHAR).join("\n");
};
const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isEscapeKey = (key: KeyEvent): boolean => {
  if (key.name === "escape" || key.name === "esc") return true;
  if (key.code === "Escape") return true;
  if (key.baseCode === 27) return true;
  if (key.raw === "\u001b" || key.sequence === "\u001b") return true;
  return false;
};

const getToolMessageKey = (taskId: string, message: { toolName: string; toolCallId?: string }): string =>
  `${taskId}::${message.toolCallId ?? `${message.toolName}:no-id`}`;

const formatJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return `Failed to format JSON: ${formatErrorMessage(error)}`;
  }
};

const extractContextWorkspace = (context: unknown): string | null => {
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    return null;
  }

  const runtime = (context as Record<string, unknown>).runtime;
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
    return null;
  }

  const workspace = (runtime as Record<string, unknown>).workspace;
  if (typeof workspace !== "string" || workspace.trim() === "") {
    return null;
  }
  return workspace;
};

class CoreTuiClientApp {
  private readonly client: GatewayClient;
  private readonly pollIntervalMs: number;
  private readonly serverUrl?: string;
  private readonly mode?: "hybrid" | "tui" | "tui-client";
  private readonly ui: TuiClientUiBundle;

  private destroyed = false;
  private readonly state: TuiClientState;

  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private deferredUiSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private ctrlCExitConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCtrlCPressAt = 0;
  private escForceAbortConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEscPressAt = 0;
  private inputNoticeText = "";

  private readonly appRoot: BoxRenderable;

  private readonly messageBox: BoxRenderable;
  private readonly messageHeaderText: TextRenderable;
  private readonly messageSubHeaderText: TextRenderable;
  private readonly messageScroll: ScrollBoxRenderable;
  private readonly messageListBox: BoxRenderable;

  private readonly statusBox: BoxRenderable;
  private readonly statusRowTexts: [TextRenderable, TextRenderable];

  private readonly inputBox: BoxRenderable;
  private readonly inputRailBox: BoxRenderable;
  private readonly inputRailAccent: BoxRenderable;
  private readonly inputRailAccentGlyph: TextRenderable;
  private readonly inputRailTextUser: TextRenderable;
  private readonly inputRailTextInput: TextRenderable;
  private readonly inputMainBox: BoxRenderable;
  private readonly inputHintText: TextRenderable;
  private readonly inputEditorHost: BoxRenderable;
  private readonly inputTextarea: TextareaRenderable;

  private readonly slashOverlay: BoxRenderable;
  private readonly slashBackdrop: BoxRenderable;
  private readonly slashModalBox: BoxRenderable;
  private readonly slashModalTitleText: TextRenderable;
  private readonly slashModalQueryText: TextRenderable;
  private readonly slashModalEmptyText: TextRenderable;
  private readonly slashModalSelect: SelectRenderable;

  private readonly contextOverlay: BoxRenderable;
  private readonly contextBackdrop: BoxRenderable;
  private readonly contextModalBox: BoxRenderable;
  private readonly contextModalTitleText: TextRenderable;
  private readonly contextModalHintText: TextRenderable;
  private readonly contextModalScroll: ScrollBoxRenderable;
  private readonly contextModalContentBox: BoxRenderable;
  private readonly contextModalBodyText: TextRenderable;

  private readonly onResize = () => {
    if (this.destroyed) return;
    this.refreshAll();
  };

  private readonly onGlobalKeyPress = (key: KeyEvent) => {
    if (this.destroyed) return;

    const isPrimaryKeyEvent = key.eventType === "press" || key.eventType === "repeat";
    if (!isPrimaryKeyEvent) return;

    if (key.ctrl && !key.meta && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      this.handleCtrlCExitAttempt();
      return;
    }

    if (this.handleContextModalKeyPress(key)) {
      return;
    }

    if (this.handleSlashModalKeyPress(key)) {
      return;
    }

    if (isEscapeKey(key) && this.isBusy()) {
      key.preventDefault();
      key.stopPropagation();
      this.handleEscForceAbortAttempt();
      return;
    }

    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      this.state.focusTarget = "input";

      this.syncFocus();
      this.syncStatusStrip();
      this.renderer.requestRender();
      return;
    }

    this.schedulePostInputUiSync();
  };

  constructor(private readonly renderer: CliRenderer, options: CoreTuiClientOptions) {
    this.client = options.client;
    this.pollIntervalMs = options.pollIntervalMs;
    this.serverUrl = options.serverUrl;
    this.mode = options.mode;
    const initialAgentName = options.agentName?.trim() || DEFAULT_AGENT_NAME;
    this.state = new TuiClientState({
      terminal: getTerminalSize(renderer),
      agentName: initialAgentName,
    });

    this.ui = createTuiClientUiBundle(renderer, {
      textareaKeyBindings: TEXTAREA_SUBMIT_KEY_BINDINGS,
      onInputSubmit: () => {
        if (this.handleSubmit(this.inputTextarea.plainText)) {
          this.inputTextarea.replaceText("");
          this.syncSlashModalStateFromInput();
          this.refreshAll();
        }
      },
      onSlashSelect: () => {
        this.applySelectedSlashCommand();
      },
      onContextSave: () => {
        void this.persistContextModalToLog();
      },
    });
    this.appRoot = this.ui.appRoot;
    this.messageBox = this.ui.messageBox;
    this.messageHeaderText = this.ui.messageHeaderText;
    this.messageSubHeaderText = this.ui.messageSubHeaderText;
    this.messageScroll = this.ui.messageScroll;
    this.messageListBox = this.ui.messageListBox;
    this.statusBox = this.ui.statusBox;
    this.statusRowTexts = this.ui.statusRowTexts;
    this.inputBox = this.ui.inputBox;
    this.inputRailBox = this.ui.inputRailBox;
    this.inputRailAccent = this.ui.inputRailAccent;
    this.inputRailAccentGlyph = this.ui.inputRailAccentGlyph;
    this.inputRailTextUser = this.ui.inputRailTextUser;
    this.inputRailTextInput = this.ui.inputRailTextInput;
    this.inputMainBox = this.ui.inputMainBox;
    this.inputHintText = this.ui.inputHintText;
    this.inputEditorHost = this.ui.inputEditorHost;
    this.inputTextarea = this.ui.inputTextarea;
    this.slashOverlay = this.ui.slashOverlay;
    this.slashBackdrop = this.ui.slashBackdrop;
    this.slashModalBox = this.ui.slashModalBox;
    this.slashModalTitleText = this.ui.slashModalTitleText;
    this.slashModalQueryText = this.ui.slashModalQueryText;
    this.slashModalEmptyText = this.ui.slashModalEmptyText;
    this.slashModalSelect = this.ui.slashModalSelect;
    this.contextOverlay = this.ui.contextOverlay;
    this.contextBackdrop = this.ui.contextBackdrop;
    this.contextModalBox = this.ui.contextModalBox;
    this.contextModalTitleText = this.ui.contextModalTitleText;
    this.contextModalHintText = this.ui.contextModalHintText;
    this.contextModalScroll = this.ui.contextModalScroll;
    this.contextModalContentBox = this.ui.contextModalContentBox;
    this.contextModalBodyText = this.ui.contextModalBodyText;

    this.mountViews();
    this.bindRendererEvents();

    this.refreshAll();
    void this.bootstrapHealthCheck();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.stopSpinner();
    if (this.deferredUiSyncTimer) {
      clearTimeout(this.deferredUiSyncTimer);
      this.deferredUiSyncTimer = undefined;
    }
    if (this.ctrlCExitConfirmTimer) {
      clearTimeout(this.ctrlCExitConfirmTimer);
      this.ctrlCExitConfirmTimer = undefined;
    }
    if (this.escForceAbortConfirmTimer) {
      clearTimeout(this.escForceAbortConfirmTimer);
      this.escForceAbortConfirmTimer = undefined;
    }

    this.unbindRendererEvents();
    this.unmountViews();
    this.destroyViewTrees();
  }

  private mountViews(): void {
    this.ui.mount(this.renderer);
  }

  private bindRendererEvents(): void {
    this.renderer.on("resize", this.onResize);
    this.renderer._internalKeyInput.onInternal("keypress", this.onGlobalKeyPress);
  }

  private unbindRendererEvents(): void {
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
  }

  private unmountViews(): void {
    this.ui.unmount(this.renderer);
  }

  private destroyViewTrees(): void {
    this.ui.destroyTrees();
  }

  private isBusy(): boolean {
    return this.state.isBusy();
  }

  private getEffectiveFocus(): FocusTarget {
    return this.state.getEffectiveFocus();
  }

  private getBusyIndicator(): string | undefined {
    return this.state.getBusyIndicator(WAITING_SPINNER_FRAMES);
  }

  private getLayout(): LayoutMetrics {
    return getLayoutMetrics(this.state.terminal);
  }

  private updateTerminalSize(): void {
    this.state.terminal = getTerminalSize(this.renderer);
  }

  private refreshAll(): void {
    if (this.destroyed) return;

    this.updateTerminalSize();
    this.syncSlashModalStateFromInput();
    const layout = this.getLayout();

    this.appRoot.width = "100%";
    this.appRoot.height = "100%";

    this.syncMessagePane(layout);
    this.syncStatusStrip(layout);
    this.syncInputPane(layout);
    this.syncSlashModalLayout(layout);
    this.syncContextModalLayout(layout);
    this.syncFocus();

    this.renderer.requestRender();
  }

  private syncMessagePane(layout: LayoutMetrics): void {
    const effectiveFocus = this.getEffectiveFocus();
    const headerWidth = Math.max(1, this.state.terminal.columns - PANEL_INNER_HORIZONTAL_OVERHEAD);

    this.messageBox.height = layout.messageHeight;
    this.messageBox.borderColor = effectiveFocus === "answer" ? NORD.nord8 : NORD.nord3;
    this.messageHeaderText.visible = true;
    this.messageSubHeaderText.visible = false;

    this.messageHeaderText.content = buildMessageHeaderLine(this.state.agentName, this.state.chatStream.length, headerWidth);
    this.messageSubHeaderText.content = buildMessageSubHeaderLine({
      phase: this.state.phase,
      connection: this.state.connection,
      taskId: this.state.activeTaskId,
      agentName: this.state.agentName,
      spinnerFrame: WAITING_SPINNER_FRAMES[this.state.busySpinnerIndex] ?? WAITING_SPINNER_FRAMES[0],
      width: headerWidth,
    });

    const scrollAreaHeight = Math.max(1, layout.messageHeight - MESSAGE_PANEL_VERTICAL_OVERHEAD);
    this.messageScroll.height = scrollAreaHeight;
    this.renderChatStream();
  }

  private renderChatStream(): void {
    renderMessageStreamContent({
      renderer: this.renderer,
      listBox: this.messageListBox,
      agentName: this.state.agentName,
      items: this.state.chatStream,
    });
  }

  private syncStatusStrip(layout?: LayoutMetrics): void {
    const activeLayout = layout ?? this.getLayout();
    const rowWidth = Math.max(1, this.state.terminal.columns - PANEL_INNER_HORIZONTAL_OVERHEAD);
    const effectiveFocus = this.getEffectiveFocus();

    this.statusBox.visible = activeLayout.showStatusStrip;
    this.statusBox.height = activeLayout.showStatusStrip ? activeLayout.statusHeight : 0;
    this.statusBox.borderColor = effectiveFocus === "answer" ? NORD.nord3 : NORD.nord3;

    const rows = buildStatusStripRows({
      layout: activeLayout,
      terminal: this.state.terminal,
      rowWidth,
      mode: this.mode,
      agentName: this.state.agentName,
      version: this.state.serverVersion,
      connection: this.state.connection,
      phase: this.state.phase,
      spinnerFrame: WAITING_SPINNER_FRAMES[this.state.busySpinnerIndex] ?? WAITING_SPINNER_FRAMES[0],
      busyAnimationTick: this.state.busyAnimationTick,
      activeTaskId: this.state.activeTaskId,
      serverUrl: this.serverUrl,
      statusNotice: this.state.statusNotice,
    });

    for (let index = 0; index < this.statusRowTexts.length; index += 1) {
      const rowText = this.statusRowTexts[index]!;
      rowText.visible = activeLayout.showStatusStrip && index < activeLayout.statusRows;
      rowText.content = rows[index] && rows[index]!.length > 0 ? rows[index]! : " ";
    }
  }

  private syncInputPane(layout: LayoutMetrics): void {
    const effectiveFocus = this.getEffectiveFocus();
    const inputFocused = effectiveFocus === "input";
    const busyIndicator = this.getBusyIndicator();
    const editorHeight = INPUT_EDITOR_ROWS;
    const viewState = buildInputPaneViewState({
      isBusy: this.isBusy(),
      inputFocused,
      busyIndicator,
      agentName: this.state.agentName,
      noticeText: this.inputNoticeText,
    });

    this.inputBox.height = layout.inputHeight;
    this.inputBox.backgroundColor = inputFocused ? NORD.nord1 : NORD.nord1;

    this.inputRailBox.width = layout.railWidth;
    this.inputRailBox.backgroundColor = NORD.nord1;
    this.inputRailAccent.backgroundColor = NORD.nord1;
    this.inputRailAccentGlyph.fg = viewState.railAccentColor === "focused" ? NORD.nord8 : NORD.nord9;
    this.inputRailAccentGlyph.content = buildInputRailGlyphContent(layout.inputHeight - INPUT_RAIL_INNER_VERTICAL_PADDING);
    this.inputHintText.visible = viewState.showHint;
    this.inputHintText.content = viewState.hintText;

    this.inputEditorHost.height = editorHeight;
    this.inputTextarea.height = "100%";
    this.inputTextarea.width = "100%";
    this.inputTextarea.placeholder = viewState.placeholderText;
    this.inputTextarea.backgroundColor = inputFocused ? NORD.nord2 : NORD.nord1;
    this.inputTextarea.focusedBackgroundColor = NORD.nord2;
  }

  private syncSlashModalLayout(layout: LayoutMetrics): void {
    const modalOpen = this.state.slashModalState.open;
    this.slashOverlay.visible = modalOpen;
    if (!modalOpen) return;

    const viewState = buildSlashModalLayoutState({
      terminal: this.state.terminal,
      layout,
      filteredQuery: this.state.slashModalState.filteredQuery,
      commands: this.state.slashFilteredCommands,
      selectedIndex: this.state.slashModalState.selectedIndex,
    });

    this.slashModalBox.width = viewState.width;
    this.slashModalBox.height = viewState.height;
    this.slashModalBox.top = viewState.top;
    this.slashModalBox.left = viewState.left;
    this.slashModalBox.borderColor = NORD.nord9;

    this.slashModalTitleText.content = viewState.titleText;
    this.slashModalQueryText.content = viewState.queryText;
    this.slashModalEmptyText.visible = viewState.emptyVisible;
    this.slashModalEmptyText.content = viewState.emptyText;
    this.slashModalSelect.visible = viewState.hasOptions;
    this.slashModalSelect.height = viewState.listHeight;
    this.slashModalSelect.options = viewState.options;
    this.slashModalSelect.selectedIndex = viewState.selectedIndex;
  }

  private syncContextModalLayout(_layout: LayoutMetrics): void {
    this.contextOverlay.visible = this.state.contextModalOpen;
    if (!this.state.contextModalOpen) return;

    const viewState = buildContextModalLayoutState({
      terminal: this.state.terminal,
      title: this.state.contextModalTitle,
      body: this.state.contextModalText,
    });

    this.contextModalBox.width = viewState.width;
    this.contextModalBox.height = viewState.height;
    this.contextModalBox.top = viewState.top;
    this.contextModalBox.left = viewState.left;
    this.contextModalTitleText.content = viewState.titleText;
    this.contextModalHintText.content = viewState.hintText;
    this.contextModalScroll.height = viewState.scrollHeight;
    this.contextModalBodyText.content = viewState.bodyText;
  }

  private syncFocus(): void {
    if (this.state.contextModalOpen) {
      this.inputTextarea.blur();
      this.messageScroll.blur();
      this.contextModalScroll.focus();
      return;
    }

    const effectiveFocus = this.getEffectiveFocus();
    const inputFocused = effectiveFocus === "input";

    if (inputFocused) {
      this.inputTextarea.focus();
      this.messageScroll.blur();
    } else {
      this.inputTextarea.blur();
      this.messageScroll.focus();
    }
  }

  private schedulePostInputUiSync(): void {
    if (this.deferredUiSyncTimer) return;
    this.deferredUiSyncTimer = setTimeout(() => {
      this.deferredUiSyncTimer = undefined;
      if (this.destroyed) return;
      this.refreshAll();
    }, 0);
  }

  private handleSlashModalKeyPress(key: KeyEvent): boolean {
    if (this.state.contextModalOpen) return false;
    if (!this.state.slashModalState.open) return false;
    const currentInput = this.inputTextarea.plainText;
    const singleLineSlashOnly =
      !currentInput.includes("\n") && currentInput.trimStart() === "/";

    if (isEscapeKey(key)) {
      key.preventDefault();
      key.stopPropagation();
      this.closeSlashModal();
      if (!currentInput.includes("\n") && currentInput.trimStart().startsWith("/")) {
        this.inputTextarea.replaceText("");
      }
      this.syncSlashModalStateFromInput();
      if (this.isBusy()) {
        this.handleEscForceAbortAttempt();
      }
      this.syncInputPane(this.getLayout());
      this.renderer.requestRender();
      return true;
    }

    if ((key.name === "backspace" || key.name === "delete") && singleLineSlashOnly) {
      key.preventDefault();
      key.stopPropagation();
      this.closeSlashModal();
      this.inputTextarea.replaceText("");
      this.syncSlashModalStateFromInput();
      this.syncInputPane(this.getLayout());
      this.renderer.requestRender();
      return true;
    }

    const inputFocused = this.getEffectiveFocus() === "input";
    if (!inputFocused) return false;

    if (this.state.slashFilteredCommands.length === 0) return false;

    if (key.name === "up" || key.name === "k") {
      key.preventDefault();
      key.stopPropagation();
      this.moveSlashSelection(-1);
      return true;
    }

    if (key.name === "down" || key.name === "j") {
      key.preventDefault();
      key.stopPropagation();
      this.moveSlashSelection(1);
      return true;
    }

    const isSubmitKey = (key.name === "return" || key.name === "linefeed") && !key.shift && !key.meta;
    if (isSubmitKey) {
      key.preventDefault();
      key.stopPropagation();
      this.applySelectedSlashCommand();
      return true;
    }

    return false;
  }

  private handleContextModalKeyPress(key: KeyEvent): boolean {
    if (!this.state.contextModalOpen) return false;

    if ((key.name === "s" || key.sequence === "s") && !key.ctrl && !key.meta) {
      key.preventDefault();
      key.stopPropagation();
      void this.persistContextModalToLog();
      return true;
    }

    if (isEscapeKey(key)) {
      key.preventDefault();
      key.stopPropagation();
      this.closeContextModal();
      this.renderer.requestRender();
      return true;
    }

    return false;
  }

  private moveSlashSelection(delta: number): void {
    if (this.state.slashFilteredCommands.length === 0) return;
    const maxIndex = this.state.slashFilteredCommands.length - 1;
    const next = Math.max(0, Math.min(maxIndex, this.state.slashModalState.selectedIndex + delta));
    this.state.slashModalState.selectedIndex = next;
    this.slashModalSelect.selectedIndex = next;
    this.renderer.requestRender();
  }

  private applySelectedSlashCommand(): void {
    const selected = this.state.slashFilteredCommands[this.state.slashModalState.selectedIndex];
    if (!selected) return;

    this.inputTextarea.replaceText(selected.name);
    this.closeSlashModal();
    this.syncInputPane(this.getLayout());
    this.renderer.requestRender();
  }

  private openSlashModal(query: string): void {
    if (this.state.contextModalOpen) return;
    this.state.slashModalState.open = true;
    this.updateSlashCommandOptions(query);
  }

  private closeSlashModal(): void {
    this.state.resetSlashModal();
  }

  private updateSlashCommandOptions(query: string): void {
    this.state.slashFilteredCommands = filterEnabledSlashCommands(query);
    this.state.slashModalState.filteredQuery = query;
    this.state.slashModalState.selectedIndex = Math.min(
      this.state.slashModalState.selectedIndex,
      Math.max(0, this.state.slashFilteredCommands.length - 1),
    );
    if (this.state.slashFilteredCommands.length === 0) {
      this.state.slashModalState.selectedIndex = 0;
    }
  }

  private syncSlashModalStateFromInput(): void {
    if (this.state.contextModalOpen) {
      this.closeSlashModal();
      return;
    }
    const input = this.inputTextarea.plainText;
    if (!input.startsWith("/")) {
      if (this.state.slashModalState.open) this.closeSlashModal();
      return;
    }

    const firstLine = input.split(/\r?\n/, 1)[0] ?? "/";
    if (!firstLine.startsWith("/")) {
      if (this.state.slashModalState.open) this.closeSlashModal();
      return;
    }

    this.openSlashModal(firstLine.slice(1));
  }

  private openContextModal(title: string, body: string): void {
    this.state.contextModalTitle = title;
    this.state.contextModalText = body;
    this.state.contextModalOpen = true;
    this.closeSlashModal();
    this.refreshAll();
    try {
      this.contextModalScroll.scrollTo(0);
    } catch {
      // noop
    }
  }

  private closeContextModal(): void {
    if (!this.state.contextModalOpen) return;
    this.state.contextModalOpen = false;
    this.refreshAll();
  }

  private async persistContextModalToLog(): Promise<void> {
    if (!this.state.contextModalOpen) {
      return;
    }
    let contextBody = this.state.contextModalText.trim();
    let workspace = this.state.contextWorkspace?.trim();

    try {
      const latestContext = await this.withConnectionTracking(
        () => this.client.getAgentContext(),
      );
      contextBody = this.buildLatestContextBodyForLog(latestContext);
      const latestWorkspace = extractContextWorkspace(latestContext.context);
      if (latestWorkspace) {
        workspace = latestWorkspace;
        this.state.contextWorkspace = latestWorkspace;
      }
      this.state.contextModalText = formatJson(latestContext.context);
      this.syncContextModalLayout(this.getLayout());
      this.renderer.requestRender();
    } catch (error) {
      this.appendLog(
        "system",
        `Context refresh failed, fallback to modal snapshot: ${formatErrorMessage(error)}`,
      );
    }

    if (contextBody.length === 0) {
      this.appendLog("error", "Context is empty, nothing to save.");
      this.setStatusNotice("Context is empty, nothing to save.");
      return;
    }

    if (!workspace) {
      this.appendLog("error", "Context workspace unknown, cannot save log.");
      this.setStatusNotice("Context workspace unknown, cannot save log.");
      return;
    }

    try {
      const filepath = await saveContextLog({
        workspace,
        contextBody,
      });
      this.appendLog("system", `Context saved: ${filepath}`);
      this.setStatusNotice(`Context saved: ${truncateToDisplayWidth(filepath, 48)}`);
    } catch (error) {
      const message = formatErrorMessage(error);
      this.appendLog("error", `Context save failed: ${message}`);
      this.setStatusNotice(`Context save failed: ${message}`);
    }
  }

  private buildLatestContextBodyForLog(contextResponse: AgentContextResponse): string {
    return buildContextLogPayload({
      contextResponse,
    });
  }

  private appendLog(kind: LogKind, text: string): void {
    if (this.destroyed) return;
    this.state.appendLog(kind, text);
  }

  private appendChatMessage(role: Exclude<ChatMessageRole, "tool">, text: string, taskId?: string): void {
    if (this.destroyed) return;
    this.state.appendChatMessage(role, text, taskId);
  }

  private appendToolChatMessage(args: {
    toolName: string;
    callSummary?: string;
    resultSummary?: string;
    errorMessage?: string;
    callDisplay?: Extract<TaskOutputMessage, { category: "tool"; type: "tool.call" }>["inputDisplay"];
    resultDisplay?: Extract<TaskOutputMessage, { category: "tool"; type: "tool.result" }>["outputDisplay"];
    collapsed: boolean;
    status: "running" | "done" | "error";
    taskId?: string;
  }): number {
    if (this.destroyed) return -1;
    return this.state.appendToolMessage(args);
  }

  private updateToolChatMessage(
    id: number,
    patch: Partial<{
      toolName: string;
      callSummary?: string;
      resultSummary?: string;
      errorMessage?: string;
      callDisplay?: Extract<TaskOutputMessage, { category: "tool"; type: "tool.call" }>["inputDisplay"];
      resultDisplay?: Extract<TaskOutputMessage, { category: "tool"; type: "tool.result" }>["outputDisplay"];
      collapsed: boolean;
      status: "running" | "done" | "error";
    }>,
  ): boolean {
    if (this.destroyed) return false;
    return this.state.updateToolMessage(id, patch);
  }

  private setStatusNotice(text: string): void {
    if (this.destroyed) return;
    this.state.setStatusNotice(text, summarizeEventText);
    this.syncStatusStrip();
    this.renderer.requestRender();
  }

  private setInputNotice(text: string): void {
    if (this.destroyed) return;
    const nextText = text.trim();
    if (this.inputNoticeText === nextText) return;
    this.inputNoticeText = nextText;
    this.syncInputPane(this.getLayout());
    this.renderer.requestRender();
  }

  private setClientPhase(nextPhase: ClientPhase): void {
    if (this.destroyed) return;

    this.state.phase = nextPhase;
    this.state.focusTarget = "input";

    if (nextPhase === "idle") {
      this.resetEscForceAbortConfirmState();
      this.state.busySpinnerIndex = 0;
      this.state.busyAnimationTick = 0;
      this.stopSpinner();
    } else {
      this.closeSlashModal();
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

      this.state.busySpinnerIndex = (this.state.busySpinnerIndex + 1) % WAITING_SPINNER_FRAMES.length;
      this.state.busyAnimationTick += 1;
      this.refreshAll();
    }, WAITING_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private handleCtrlCExitAttempt(): void {
    const now = Date.now();
    const withinConfirmWindow = now - this.lastCtrlCPressAt <= CTRL_C_EXIT_CONFIRM_MS;

    if (withinConfirmWindow) {
      this.lastCtrlCPressAt = 0;
      if (this.ctrlCExitConfirmTimer) {
        clearTimeout(this.ctrlCExitConfirmTimer);
        this.ctrlCExitConfirmTimer = undefined;
      }
      this.setInputNotice("");
      this.appendLog("system", "Ctrl+C confirmed. Exiting TUI...");
      this.setStatusNotice("Exiting TUI...");
      this.renderer.destroy();
      return;
    }

    this.lastCtrlCPressAt = now;
    if (this.ctrlCExitConfirmTimer) {
      clearTimeout(this.ctrlCExitConfirmTimer);
    }
    this.ctrlCExitConfirmTimer = setTimeout(() => {
      this.ctrlCExitConfirmTimer = undefined;
      this.lastCtrlCPressAt = 0;
      this.setInputNotice("");
      if (!this.destroyed && this.state.phase === "idle") {
        this.setStatusNotice("Ready");
      }
    }, CTRL_C_EXIT_CONFIRM_MS);

    this.appendLog("system", "Press Ctrl+C again to exit");
    this.setStatusNotice("Press Ctrl+C again to exit");
    this.setInputNotice("Press Ctrl+C again to exit");
  }

  private resetEscForceAbortConfirmState(): void {
    this.lastEscPressAt = 0;
    if (this.escForceAbortConfirmTimer) {
      clearTimeout(this.escForceAbortConfirmTimer);
      this.escForceAbortConfirmTimer = undefined;
    }
    if (this.inputNoticeText === "Press ESC again to force abort") {
      this.setInputNotice("");
    }
  }

  private handleEscForceAbortAttempt(): void {
    if (!this.isBusy()) {
      this.resetEscForceAbortConfirmState();
      return;
    }

    const now = Date.now();
    const withinConfirmWindow = now - this.lastEscPressAt <= CTRL_C_EXIT_CONFIRM_MS;

    if (withinConfirmWindow) {
      this.resetEscForceAbortConfirmState();
      void this.triggerForceAbort();
      return;
    }

    this.lastEscPressAt = now;
    if (this.escForceAbortConfirmTimer) {
      clearTimeout(this.escForceAbortConfirmTimer);
    }
    this.escForceAbortConfirmTimer = setTimeout(() => {
      this.escForceAbortConfirmTimer = undefined;
      this.lastEscPressAt = 0;
      this.setInputNotice("");
      if (!this.destroyed && this.state.phase === "idle") {
        this.setStatusNotice("Ready");
      }
    }, CTRL_C_EXIT_CONFIRM_MS);

    this.appendLog("system", "Press ESC again to force abort");
    this.setStatusNotice("Press ESC again to force abort");
    this.setInputNotice("Press ESC again to force abort");
  }

  private async triggerForceAbort(): Promise<void> {
    this.appendLog("command", "/force_abort");
    try {
      const result = await this.withConnectionTracking(() => this.client.forceAbort());
      this.resetEscForceAbortConfirmState();
      const line = `/force_abort ok: abortedCurrent=${result.abortedCurrent}, clearedPending=${result.clearedPendingCount}`;
      this.appendLog("system", line);
      this.setStatusNotice(`Force abort sent (cleared ${result.clearedPendingCount})`);
    } catch (error) {
      this.resetEscForceAbortConfirmState();
      const message = formatErrorMessage(error);
      this.appendLog("error", `/force_abort failed: ${message}`);
      this.setStatusNotice(`/force_abort failed: ${message}`);
    }
  }

  private markConnected(): void {
    if (this.destroyed) return;
    this.state.connection = "ok";
    this.syncStatusStrip();
    this.renderer.requestRender();
  }

  private markDisconnected(): void {
    if (this.destroyed) return;
    this.state.connection = "error";
    this.syncStatusStrip();
    this.renderer.requestRender();
  }

  private setTaskId(taskId?: string): void {
    if (this.destroyed) return;
    this.state.activeTaskId = taskId;
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
      if (!this.destroyed) {
        this.state.serverVersion = health.version?.trim() || this.state.serverVersion;
      }
      const remoteAgentName = health.name?.trim();
      if (!remoteAgentName || this.destroyed) return;
      this.state.agentName = remoteAgentName;
      this.setStatusNotice(`${this.state.agentName} connected`);
      this.refreshAll();
    } catch {
      // startup should stay non-blocking
    }
  }

  private async runSlashCommand(command: string): Promise<void> {
    this.appendLog("command", command);
    const action = resolveSlashCommandAction(command);

    if (action.type === "exit") {
      this.renderer.destroy();
      return;
    }

    if (action.type === "open_context") {
      if (this.state.phase !== "idle") {
        const message = "A task is already running. Please wait.";
        this.appendLog("error", message);
        this.setStatusNotice(message);
        return;
      }

      await executeContextCommand({
        client: this.client,
        withConnectionTracking: (operation) => this.withConnectionTracking(operation),
        formatJson,
        formatErrorMessage,
        callbacks: {
          onStart: () => {
            this.setStatusNotice("Loading context...");
            this.setClientPhase("submitting");
          },
          onSuccess: (body, context) => {
            const workspace = extractContextWorkspace(context);
            if (workspace) {
              this.state.contextWorkspace = workspace;
            }
            this.appendLog("system", "/context loaded");
            this.setStatusNotice("/context loaded");
            this.openContextModal("Agent Context", body);
          },
          onError: (message) => {
            this.appendLog("error", `/context failed: ${message}`);
            this.setStatusNotice(`/context failed: ${message}`);
          },
          onFinally: () => {
            this.setClientPhase("idle");
          },
        },
      });
      return;
    }

    if (action.type === "force_abort") {
      await this.triggerForceAbort();
      return;
    }

    if (action.type === "hidden") {
      this.appendLog("system", action.message);
      this.setStatusNotice(action.message);
      return;
    }

    this.appendLog("error", action.message);
    this.setStatusNotice(action.message);
  }

  private async runPromptTask(question: string): Promise<void> {
    if (this.state.phase !== "idle") {
      const message = "A task is already running. Please wait.";
      this.appendLog("error", message);
      this.setStatusNotice(message);
      return;
    }

    this.appendLog("user", question);
    this.appendChatMessage("user", question);
    let hasStructuredFinalAssistant = false;
    let hasVisibleTaskError = false;
    const activeToolMessageIds = new Map<string, number>();
    await executePromptTaskFlow({
      question,
      client: this.client,
      pollIntervalMs: this.pollIntervalMs,
      sleepFn: sleep,
      withConnectionTracking: (operation) => this.withConnectionTracking(operation),
      isDestroyed: () => this.destroyed,
      formatErrorMessage,
      callbacks: {
        onBeforeSubmit: () => {
          this.setStatusNotice("Submitting request...");
          this.setClientPhase("submitting");
          this.setTaskId(undefined);
        },
        onTaskCreated: (taskId) => {
          this.setTaskId(taskId);
          this.appendLog("system", `Task created: ${taskId}`);
          this.setStatusNotice(`Task created: ${taskId}`);
          this.setClientPhase("polling");
        },
        onTaskMessages: (taskId, messages) => {
          let hasUiUpdate = false;

          for (const message of messages) {
            if (message.category === "assistant" && message.type === "assistant.text") {
              if (message.final) {
                hasStructuredFinalAssistant = true;
                this.appendChatMessage("assistant", message.text, taskId);
                hasUiUpdate = true;
              }
              continue;
            }

            if (message.category === "other" && message.type === "task.error") {
              hasVisibleTaskError = true;
              this.appendChatMessage("system", `Task failed: ${message.text}`, taskId);
              hasUiUpdate = true;
              continue;
            }

            if (
              message.category === "other" &&
              message.type === "task.finish" &&
              message.finishReason &&
              isTaskExecutionStopReason(message.finishReason)
            ) {
              this.appendLog(
                "system",
                `Task stopped: ${message.finishReason.replaceAll("_", " ")}`,
              );
              hasUiUpdate = true;
              continue;
            }

            if (message.category !== "tool") {
              continue;
            }

            if (message.type === "tool.call") {
              const key = getToolMessageKey(taskId, message);
              const existingId = activeToolMessageIds.get(key);

              if (existingId !== undefined) {
                this.updateToolChatMessage(existingId, {
                  toolName: message.toolName,
                  callSummary: message.inputSummary,
                  callDisplay: message.inputDisplay,
                  collapsed: true,
                  status: "running",
                });
              } else {
                const id = this.appendToolChatMessage({
                  toolName: message.toolName,
                  callSummary: message.inputSummary,
                  callDisplay: message.inputDisplay,
                  collapsed: true,
                  status: "running",
                  taskId,
                });
                if (id >= 0) {
                  activeToolMessageIds.set(key, id);
                }
              }

              hasUiUpdate = true;
              continue;
            }

            if (message.type !== "tool.result") {
              continue;
            }

            const key = getToolMessageKey(taskId, message);
            const status = message.ok ? "done" : "error";
            const existingId = activeToolMessageIds.get(key);

            if (existingId !== undefined) {
              this.updateToolChatMessage(existingId, {
                toolName: message.toolName,
                resultSummary: message.outputSummary,
                errorMessage: message.errorMessage,
                resultDisplay: message.outputDisplay,
                collapsed: true,
                status,
              });
              activeToolMessageIds.delete(key);
            } else {
              this.appendToolChatMessage({
                toolName: message.toolName,
                resultSummary: message.outputSummary,
                errorMessage: message.errorMessage,
                resultDisplay: message.outputDisplay,
                collapsed: true,
                status,
                taskId,
              });
            }
            hasUiUpdate = true;
          }

          if (hasUiUpdate) {
            this.refreshAll();
          }
        },
        onTaskCompleted: (taskId, summary) => {
          if (summary.kind === "assistant_reply" && !hasStructuredFinalAssistant) {
            this.appendChatMessage("assistant", summary.replyText, taskId);
          }
          if (summary.kind === "error" && !hasVisibleTaskError) {
            this.appendChatMessage("system", summary.statusNotice, taskId);
          }
          this.appendLog(summary.logKind, summary.statusNotice);
          this.setStatusNotice(summary.statusNotice);
          this.refreshAll();
        },
        onRequestError: (message) => {
          this.appendLog("error", `Request failed: ${message}`);
          this.setStatusNotice(`Request failed: ${message}`);
        },
        onFinally: () => {
          this.setTaskId(undefined);
          this.setClientPhase("idle");
        },
      },
    });
  }

  private handleSubmit(rawValue: string): boolean {
    if (this.destroyed || this.getEffectiveFocus() !== "input") {
      return false;
    }

    const submitValue = rawValue.replace(/\r?\n$/, "");
    const trimmedValue = submitValue.trim();

    if (!trimmedValue) {
      return true;
    }

    const isSingleLineSlash = !submitValue.includes("\n") && trimmedValue.startsWith("/");
    if (isSingleLineSlash) {
      if (this.state.phase !== "idle" && trimmedValue !== "/force_abort") {
        return false;
      }
      void this.runSlashCommand(trimmedValue);
      return true;
    }

    if (this.state.phase !== "idle") {
      return false;
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
    exitOnCtrlC: false,
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
