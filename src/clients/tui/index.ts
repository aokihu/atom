/**
 * TUI client application entry (coordinator layer).
 *
 * Purpose:
 * - Wire renderer lifecycle, network flows, keyboard routing, and state.
 * - Delegate all concrete UI rendering to view controllers.
 */

import { sleep } from "bun";
import { BoxRenderable, createCliRenderer } from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";

import type { GatewayClient } from "../../libs/channel/channel";
import type { MCPHealthStatus, TaskOutputMessage } from "../../types/http";
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
  type FocusTarget,
  type LogKind,
  TuiClientState,
} from "./runtime/state";
import { createTuiClientUiBundle, type TuiClientUiBundle } from "./runtime/ui";
import { filterEnabledSlashCommands } from "./state/slash_commands";
import { resolveTuiTheme, type TuiTheme } from "./theme";
import { summarizeEventText, truncateToDisplayWidth } from "./utils/text";
import type { ContextModalRenderInput } from "./views/context_modal";
import type { InputPaneRenderInput } from "./views/input_pane";
import type { MessagePaneRenderInput } from "./views/message_pane";
import type { SlashModalRenderInput } from "./views/slash_modal";
import type { StatusStripViewInput } from "./views/status_strip";

type StartTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs?: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName?: string;
  version?: string;
  themeName?: string;
};

type CoreTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
  agentName?: string;
  version?: string;
  themeName?: string;
};

const PANEL_INNER_HORIZONTAL_OVERHEAD = 4; // border(2) + paddingX(2)
const DEFAULT_AGENT_NAME = "Atom";
const WAITING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const WAITING_SPINNER_INTERVAL_MS = 120;
const STREAM_UI_REFRESH_DEBOUNCE_MS = 48;
const CTRL_C_EXIT_CONFIRM_MS = 1500;
const TEXTAREA_SUBMIT_KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "linefeed", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "linefeed", shift: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "linefeed", meta: true, action: "newline" as const },
];
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

const formatMcpStatusModalBody = (mcp: MCPHealthStatus): string => {
  if (mcp.total <= 0) {
    return "No MCP servers configured.";
  }

  const lines = [
    `Connected: ${mcp.connected}/${mcp.total}`,
    "",
    ...mcp.servers.map((server) => {
      const transport = `[${server.transport}]`;
      if (server.connected) {
        return `- ${server.id}  ${transport}  connected`;
      }
      const reason = server.message?.trim() || "connection failed";
      return `- ${server.id}  ${transport}  failed: ${reason}`;
    }),
  ];

  return lines.join("\n");
};

class CoreTuiClientApp {
  private readonly client: GatewayClient;
  private readonly pollIntervalMs: number;
  private readonly serverUrl?: string;
  private readonly mode?: "hybrid" | "tui" | "tui-client";
  private readonly theme: TuiTheme;
  private readonly ui: TuiClientUiBundle;

  private destroyed = false;
  private readonly state: TuiClientState;

  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private deferredUiSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private streamUiRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private ctrlCExitConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCtrlCPressAt = 0;
  private escForceAbortConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEscPressAt = 0;
  private inputNoticeText = "";

  private readonly appRoot: BoxRenderable;

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
    this.theme = resolveTuiTheme(options.themeName);
    const initialAgentName = options.agentName?.trim() || DEFAULT_AGENT_NAME;
    const initialVersion = options.version?.trim() || "unknown";
    this.state = new TuiClientState({
      terminal: getTerminalSize(renderer),
      agentName: initialAgentName,
    });
    this.state.serverVersion = initialVersion;

    this.ui = createTuiClientUiBundle(renderer, {
      theme: this.theme,
      textareaKeyBindings: TEXTAREA_SUBMIT_KEY_BINDINGS,
      onInputSubmit: () => {
        if (this.handleSubmit(this.ui.input.getValue())) {
          this.ui.input.clear();
          this.syncSlashModalStateFromInput();
          this.refreshAll();
        }
      },
      onSlashSelect: () => {
        this.applySelectedSlashCommand();
      },
      onMcpTagClick: () => {
        void this.openMcpStatusModal();
      },
    });
    this.appRoot = this.ui.appRoot;

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
    if (this.streamUiRefreshTimer) {
      clearTimeout(this.streamUiRefreshTimer);
      this.streamUiRefreshTimer = undefined;
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
    this.ui.disposeControllers();
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
    const input: MessagePaneRenderInput = {
      layout,
      terminalColumns: this.state.terminal.columns,
      answerFocused: this.getEffectiveFocus() === "answer",
      phase: this.state.phase,
      connection: this.state.connection,
      taskId: this.state.activeTaskId,
      agentName: this.state.agentName,
      spinnerFrame: WAITING_SPINNER_FRAMES[this.state.busySpinnerIndex] ?? WAITING_SPINNER_FRAMES[0],
      items: this.state.chatStream,
      onToggleToolCardCollapse: (toolMessageId, nextCollapsed) => {
        const updated = this.updateToolChatMessage(toolMessageId, {
          collapsed: nextCollapsed,
        });
        if (!updated) return;
        this.refreshAll();
      },
    };
    this.ui.message.syncFromAppState(input);
  }

  private syncStatusStrip(layout?: LayoutMetrics): void {
    const activeLayout = layout ?? this.getLayout();
    const rowWidth = Math.max(1, this.state.terminal.columns - PANEL_INNER_HORIZONTAL_OVERHEAD);
    const input: StatusStripViewInput = {
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
      mcpConnected: this.state.mcpConnected,
      mcpTotal: this.state.mcpTotal,
    };
    this.ui.status.syncFromAppState(input);
  }

  private syncInputPane(layout: LayoutMetrics): void {
    const input: Omit<InputPaneRenderInput, "noticeText"> = {
      layout,
      isBusy: this.isBusy(),
      inputFocused: this.getEffectiveFocus() === "input",
      busyIndicator: this.getBusyIndicator(),
      agentName: this.state.agentName,
    };
    this.ui.input.syncFromAppState(input);
  }

  private syncSlashModalLayout(layout: LayoutMetrics): void {
    const input: SlashModalRenderInput = {
      modalOpen: this.state.slashModalState.open,
      terminal: this.state.terminal,
      layout,
      filteredQuery: this.state.slashModalState.filteredQuery,
      commands: this.state.slashFilteredCommands,
      selectedIndex: this.state.slashModalState.selectedIndex,
    };
    this.ui.slash.syncFromAppState(input);
  }

  private syncContextModalLayout(_layout: LayoutMetrics): void {
    const input: ContextModalRenderInput = {
      open: this.state.contextModalOpen,
      terminal: this.state.terminal,
      title: this.state.contextModalTitle,
      body: this.state.contextModalText,
    };
    this.ui.context.syncFromAppState(input);
  }

  private syncFocus(): void {
    if (this.state.contextModalOpen) {
      this.ui.input.blur();
      this.ui.message.blur();
      this.ui.context.focus();
      return;
    }

    const effectiveFocus = this.getEffectiveFocus();
    const inputFocused = effectiveFocus === "input";

    if (inputFocused) {
      this.ui.input.focus();
      this.ui.message.blur();
    } else {
      this.ui.input.blur();
      this.ui.message.focus();
    }
    this.ui.context.blur();
  }

  private schedulePostInputUiSync(): void {
    if (this.deferredUiSyncTimer) return;
    this.deferredUiSyncTimer = setTimeout(() => {
      this.deferredUiSyncTimer = undefined;
      if (this.destroyed) return;
      this.refreshAll();
    }, 0);
  }

  private scheduleStreamUiRefresh(): void {
    if (this.streamUiRefreshTimer) return;
    this.streamUiRefreshTimer = setTimeout(() => {
      this.streamUiRefreshTimer = undefined;
      if (this.destroyed) return;
      this.refreshAll();
    }, STREAM_UI_REFRESH_DEBOUNCE_MS);
  }

  private flushStreamUiRefresh(): void {
    if (!this.streamUiRefreshTimer) return;
    clearTimeout(this.streamUiRefreshTimer);
    this.streamUiRefreshTimer = undefined;
  }

  private handleSlashModalKeyPress(key: KeyEvent): boolean {
    if (this.state.contextModalOpen) return false;
    if (!this.ui.slash.isOpen()) return false;
    const currentInput = this.ui.input.getValue();
    const singleLineSlashOnly =
      !currentInput.includes("\n") && currentInput.trimStart() === "/";
    const action = this.ui.slash.handleKey({
      key,
      inputFocused: this.getEffectiveFocus() === "input",
      singleLineSlashOnly,
    });
    if (!action.handled) return false;

    key.preventDefault();
    key.stopPropagation();

    if (action.kind === "close") {
      this.closeSlashModal();
      if (!currentInput.includes("\n") && currentInput.trimStart().startsWith("/")) {
        this.ui.input.clear();
      }
      this.syncSlashModalStateFromInput();
      if (this.isBusy() && isEscapeKey(key)) {
        this.handleEscForceAbortAttempt();
      }
      this.syncInputPane(this.getLayout());
      this.renderer.requestRender();
      return true;
    }

    if (action.kind === "apply") {
      this.applySelectedSlashCommand();
      return true;
    }

    if (action.kind === "navigated") {
      this.state.slashModalState.selectedIndex = this.ui.slash.getSelectedIndex();
      this.renderer.requestRender();
      return true;
    }

    return true;
  }

  private handleContextModalKeyPress(key: KeyEvent): boolean {
    if (!this.state.contextModalOpen) return false;

    if (this.ui.context.handleKey(key)) {
      key.preventDefault();
      key.stopPropagation();
      this.closeContextModal();
      this.renderer.requestRender();
      return true;
    }

    return false;
  }

  private applySelectedSlashCommand(): void {
    const selected = this.ui.slash.applySelection();
    if (!selected) return;

    this.ui.input.setValue(selected.name);
    this.closeSlashModal();
    this.syncInputPane(this.getLayout());
    this.renderer.requestRender();
  }

  private openSlashModal(query: string): void {
    if (this.state.contextModalOpen) return;
    this.state.slashModalState.open = true;
    this.updateSlashCommandOptions(query);
    this.ui.slash.open({
      terminal: this.state.terminal,
      layout: this.getLayout(),
      query,
      commands: this.state.slashFilteredCommands,
      selectedIndex: this.state.slashModalState.selectedIndex,
    });
  }

  private closeSlashModal(): void {
    this.state.resetSlashModal();
    this.ui.slash.close();
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
    const input = this.ui.input.getValue();
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
    this.ui.context.open({
      terminal: this.state.terminal,
      title,
      body,
    });
    this.refreshAll();
    this.ui.context.scrollTop();
  }

  private closeContextModal(): void {
    if (!this.state.contextModalOpen) return;
    this.state.contextModalOpen = false;
    this.ui.context.close();
    this.refreshAll();
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
    step?: number;
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
      step?: number;
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
    this.ui.input.setInputNotice(nextText);
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
      this.syncStatusStrip();
      this.renderer.requestRender();
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
        if (health.mcp) {
          this.state.mcpConnected = health.mcp.connected;
          this.state.mcpTotal = health.mcp.total;
        }
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

  private async openMcpStatusModal(): Promise<void> {
    if (this.destroyed) return;

    try {
      this.setStatusNotice("Loading MCP status...");
      const health = await this.withConnectionTracking(() => this.client.getHealth({ probeMcpHttp: true }));
      const mcp = health.mcp ?? {
        connected: 0,
        total: 0,
        servers: [],
      } satisfies MCPHealthStatus;
      this.state.mcpConnected = mcp.connected;
      this.state.mcpTotal = mcp.total;
      this.openContextModal("MCP Tools", formatMcpStatusModalBody(mcp));
      this.setStatusNotice(`MCP status loaded (${mcp.connected}/${mcp.total})`);
      this.refreshAll();
    } catch (error) {
      const message = formatErrorMessage(error);
      this.appendLog("error", `MCP status failed: ${message}`);
      this.setStatusNotice(`MCP status failed: ${message}`);
      this.refreshAll();
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
          onSuccess: (body) => {
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
                  step: message.step,
                  callSummary: message.inputSummary,
                  callDisplay: message.inputDisplay,
                  collapsed: message.toolName === "bash" ? false : true,
                  status: "running",
                });
              } else {
                const id = this.appendToolChatMessage({
                  toolName: message.toolName,
                  step: message.step,
                  callSummary: message.inputSummary,
                  callDisplay: message.inputDisplay,
                  collapsed: message.toolName === "bash" ? false : true,
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
                step: message.step,
                resultSummary: message.outputSummary,
                errorMessage: message.errorMessage,
                resultDisplay: message.outputDisplay,
                collapsed: message.toolName === "bash" ? false : true,
                status,
              });
              activeToolMessageIds.delete(key);
            } else {
              this.appendToolChatMessage({
                toolName: message.toolName,
                step: message.step,
                resultSummary: message.outputSummary,
                errorMessage: message.errorMessage,
                resultDisplay: message.outputDisplay,
                collapsed: message.toolName === "bash" ? false : true,
                status,
                taskId,
              });
            }
            hasUiUpdate = true;
          }

          if (hasUiUpdate) {
            this.scheduleStreamUiRefresh();
          }
        },
        onTaskCompleted: (taskId, summary) => {
          this.flushStreamUiRefresh();
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
  const { client, pollIntervalMs = 500, serverUrl, mode, agentName, version, themeName } = options;

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
      version,
      themeName,
    });

    await waitForExit;
  } catch (error) {
    renderer.destroy();
    throw error;
  } finally {
    app?.destroy();
  }
};
