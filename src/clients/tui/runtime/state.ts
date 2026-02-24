import type { TerminalSize } from "../layout/metrics";
import type { SlashCommandOption } from "../state/slash_commands";

export type ClientPhase = "idle" | "submitting" | "polling";
export type ConnectionState = "unknown" | "ok" | "error";
export type LogKind = "system" | "user" | "assistant" | "error" | "command";
export type FocusTarget = "input" | "answer";
export type ChatMessageRole = "user" | "assistant";

export type LogEntry = {
  id: number;
  kind: LogKind;
  text: string;
  createdAt: number;
};

export type ChatStreamItem = {
  id: number;
  role: ChatMessageRole;
  text: string;
  createdAt: number;
  taskId?: string;
};

export type SlashModalState = {
  open: boolean;
  filteredQuery: string;
  selectedIndex: number;
};

const MAX_RENDER_ENTRIES = 200;
const MAX_CHAT_STREAM_ITEMS = 200;

const createInitialEntries = (): LogEntry[] => [
  {
    id: 1,
    kind: "system",
    text: "OpenTUI TUI ready.",
    createdAt: Date.now(),
  },
];

export class TuiClientState {
  terminal: TerminalSize;

  entries: LogEntry[] = createInitialEntries();
  nextLogId = 2;
  chatStream: ChatStreamItem[] = [];
  nextChatId = 1;
  agentName: string;
  phase: ClientPhase = "idle";
  connection: ConnectionState = "unknown";
  activeTaskId?: string;
  focusTarget: FocusTarget = "input";
  busySpinnerIndex = 0;
  statusNotice = "Ready";
  contextModalOpen = false;
  contextModalText = "";
  contextModalTitle = "Context";
  slashModalState: SlashModalState = {
    open: false,
    filteredQuery: "",
    selectedIndex: 0,
  };
  slashFilteredCommands: SlashCommandOption[] = [];

  constructor(args: { terminal: TerminalSize; agentName: string }) {
    this.terminal = args.terminal;
    this.agentName = args.agentName;
  }

  isBusy(): boolean {
    return this.phase !== "idle";
  }

  getEffectiveFocus(): FocusTarget {
    return this.isBusy() ? "answer" : this.focusTarget;
  }

  getBusyIndicator(spinnerFrames: readonly string[]): string | undefined {
    if (this.phase === "idle") return undefined;

    const frame = spinnerFrames[this.busySpinnerIndex] ?? spinnerFrames[0] ?? "-";
    if (this.phase === "submitting") return `${frame} sending request`;
    return `${frame} ${this.agentName} generating`;
  }

  appendLog(kind: LogKind, text: string): void {
    const nextEntry: LogEntry = {
      id: this.nextLogId++,
      kind,
      text,
      createdAt: Date.now(),
    };

    const next = [...this.entries, nextEntry];
    this.entries = next.length > MAX_RENDER_ENTRIES ? next.slice(-MAX_RENDER_ENTRIES) : next;
  }

  appendChatMessage(role: ChatMessageRole, text: string, taskId?: string): void {
    const next: ChatStreamItem = {
      id: this.nextChatId++,
      role,
      text,
      taskId,
      createdAt: Date.now(),
    };
    const merged = [...this.chatStream, next];
    this.chatStream = merged.length > MAX_CHAT_STREAM_ITEMS ? merged.slice(-MAX_CHAT_STREAM_ITEMS) : merged;
  }

  setStatusNotice(text: string, summarizeFn: (text: string, maxWidth?: number) => string): void {
    this.statusNotice = summarizeFn(text, Math.max(20, this.terminal.columns - 8));
  }

  resetSlashModal(): void {
    this.slashModalState.open = false;
    this.slashModalState.filteredQuery = "";
    this.slashModalState.selectedIndex = 0;
    this.slashFilteredCommands = [];
  }
}
