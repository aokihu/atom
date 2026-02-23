import { useEffect, useRef, useState } from "react";
import { sleep } from "bun";
import { createCliRenderer } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";

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

type TuiAppProps = {
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
    "  Enter            Submit when input is focused",
    "  Ctrl+C           Exit",
    "",
    "Answer scrolling:",
    "  Use Scroll Area default keyboard/mouse behavior when Answer is focused.",
    "",
    "Slash commands:",
    "  /help  /messages  /context  /exit",
  ].join("\n"),
});

const getKindColor = (kind: LogKind): string => {
  switch (kind) {
    case "user":
      return "cyan";
    case "assistant":
      return "green";
    case "error":
      return "red";
    case "command":
      return "yellow";
    case "system":
    default:
      return "gray";
  }
};

const getKindPrefix = (kind: LogKind, agentName: string): string => {
  switch (kind) {
    case "user":
      return "You";
    case "assistant":
      return agentName;
    case "error":
      return "Error";
    case "command":
      return "Cmd";
    case "system":
    default:
      return "Info";
  }
};

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
  "Enter     Submit when input is focused",
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

const useTerminalSize = (): TerminalSize => {
  const { width, height } = useTerminalDimensions();

  return {
    columns: Math.max(MIN_TERMINAL_COLUMNS, toSafeNumber(width, 80)),
    rows: Math.max(MIN_TERMINAL_ROWS, toSafeNumber(height, 24)),
  };
};

const getLayoutMetrics = (terminal: TerminalSize): LayoutMetrics => {
  const mode: LayoutMode = terminal.rows < 16 ? "tiny" : terminal.rows < 22 ? "compact" : "full";
  const showEventStrip = mode !== "tiny";
  const eventRows = mode === "full" ? 3 : mode === "compact" ? 1 : 0;
  const eventStripHeight = showEventStrip ? eventRows + 3 : 0; // border(2) + title(1) + rows
  const showInputHint = mode !== "tiny";
  const inputHeight = showInputHint ? 5 : 4; // border(2) + title + [hint] + input
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

const AnswerPane = (props: {
  height: number;
  terminalWidth: number;
  mainPanel: MainPanelContent;
  focus: FocusTarget;
  agentName: string;
}) => {
  const { height, terminalWidth, mainPanel, focus, agentName } = props;

  const headerWidth = Math.max(1, terminalWidth - PANEL_INNER_HORIZONTAL_OVERHEAD);
  const titleLine = buildAnswerTitleLine(mainPanel, headerWidth, agentName);
  const statusLine = truncateToDisplayWidth(
    buildAgentMetaLine({
      mainPanel,
      compact: terminalWidth < 50,
    }),
    headerWidth,
  );
  const contentColor = getMainPanelColor(mainPanel.kind);
  const scrollAreaHeight = Math.max(1, height - ANSWER_PANEL_VERTICAL_OVERHEAD);

  return (
    <box
      border
      borderStyle="single"
      borderColor={focus === "answer" ? "cyan" : "gray"}
      paddingX={1}
      flexDirection="column"
      height={height}
      width="100%"
    >
      <text fg="cyan">{titleLine || `${agentName} Answer Zone`}</text>
      <text fg="gray">{statusLine || "status unavailable"}</text>
      <scrollbox
        height={scrollAreaHeight}
        width="100%"
        focused={focus === "answer"}
        scrollX={false}
        scrollY
      >
        <box width="100%">
          <text fg={mainPanel.kind === "empty" ? "gray" : contentColor} wrapMode="char">
            {mainPanel.body.length > 0 ? mainPanel.body : " "}
          </text>
        </box>
      </scrollbox>
    </box>
  );
};

const SystemStatusStrip = (props: {
  height: number;
  terminalWidth: number;
  visibleRows: number;
  mode?: "hybrid" | "tui" | "tui-client";
  serverUrl?: string;
  connection: ConnectionState;
  phase: ClientPhase;
  activeTaskId?: string;
  focus: FocusTarget;
  terminal: TerminalSize;
  layoutMode: LayoutMode;
  mainPanel: MainPanelContent;
}) => {
  const {
    height,
    terminalWidth,
    visibleRows,
    mode,
    serverUrl,
    connection,
    phase,
    activeTaskId,
    focus,
    terminal,
    layoutMode,
    mainPanel,
  } = props;
  const rowWidth = Math.max(1, terminalWidth - PANEL_INNER_HORIZONTAL_OVERHEAD);
  const displayMode = mode === "hybrid" ? "tui" : (mode ?? "tui");
  const rows = [
    `mode:${displayMode}  layout:${layoutMode}  conn:${connection}  state:${phase}`,
    `server:${serverUrl ?? "(unknown)"}${activeTaskId ? `  task:${activeTaskId}` : ""}`,
    `term:${terminal.columns}x${terminal.rows}  focus:${focus}  scroll:scrollbox`,
    `panel:${mainPanel.kind}  title:${mainPanel.title}${mainPanel.sourceLabel ? `  src:${mainPanel.sourceLabel}` : ""}`,
  ]
    .slice(0, Math.max(0, visibleRows))
    .map((line) => truncateToDisplayWidth(line, rowWidth));

  return (
    <box
      border
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      height={height}
      width="100%"
    >
      <text fg="cyan">System Status</text>
      {Array.from({ length: visibleRows }, (_, index) => {
        const line = rows[index];
        if (!line) {
          return (
            <box key={`status-empty-${index}`} width="100%">
              <text>{" "}</text>
            </box>
          );
        }

        return (
          <box key={`status-line-${index}`} width="100%">
            <text fg="gray">{line.length > 0 ? line : " "}</text>
          </box>
        );
      })}
    </box>
  );
};

const InputPane = (props: {
  height: number;
  isBusy: boolean;
  focus: FocusTarget;
  inputValue: string;
  onChange: (value: string) => void;
  showHint: boolean;
  agentName: string;
}) => {
  const { height, isBusy, focus, inputValue, onChange, showHint, agentName } = props;
  const inputFocused = !isBusy && focus === "input";

  return (
    <box
      border
      borderStyle="single"
      borderColor={inputFocused ? "cyan" : "gray"}
      paddingX={1}
      flexDirection="column"
      height={height}
      width="100%"
    >
      <text fg="cyan">User Input Zone</text>
      {showHint ? (
        <text fg="gray">
          {isBusy
            ? "Task in progress... input is locked; switch to answer view to scroll."
            : "Enter to submit. Tab switches focus."}
        </text>
      ) : null}
      <box width="100%">
        <input
          value={inputValue}
          onChange={onChange}
          placeholder={
            isBusy ? "Waiting for task completion..." : `Ask ${agentName} or type /help`
          }
          focused={inputFocused}
          width="100%"
        />
      </box>
    </box>
  );
};

const TuiApp = ({ client, pollIntervalMs, serverUrl, mode, agentName: initialAgentName }: TuiAppProps) => {
  const renderer = useRenderer();
  const terminal = useTerminalSize();
  const fallbackAgentName = initialAgentName?.trim() || DEFAULT_AGENT_NAME;

  const [inputValue, setInputValue] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>(() => createInitialEntries());
  const [agentName, setAgentName] = useState<string>(fallbackAgentName);
  const [mainPanelContent, setMainPanelContent] = useState<MainPanelContent>(() =>
    createInitialMainPanelContent(fallbackAgentName),
  );
  const [phase, setPhase] = useState<ClientPhase>("idle");
  const [connection, setConnection] = useState<ConnectionState>("unknown");
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>("input");

  const mountedRef = useRef(true);
  const nextLogIdRef = useRef(2);
  const phaseRef = useRef<ClientPhase>("idle");

  const layout = getLayoutMetrics(terminal);
  const isBusy = phase !== "idle";
  const effectiveFocus: FocusTarget = isBusy ? "answer" : focusTarget;

  const appendLog = (kind: LogKind, text: string) => {
    if (!mountedRef.current) return;

    const nextEntry: LogEntry = {
      id: nextLogIdRef.current++,
      kind,
      text,
      createdAt: Date.now(),
    };

    setEntries((prev) => {
      const next = [...prev, nextEntry];
      return next.length > MAX_RENDER_ENTRIES ? next.slice(-MAX_RENDER_ENTRIES) : next;
    });
  };

  const setMainPanelContentSafe = (next: MainPanelContent) => {
    if (!mountedRef.current) return;
    setMainPanelContent(next);
  };

  const setClientPhase = (nextPhase: ClientPhase) => {
    phaseRef.current = nextPhase;
    if (!mountedRef.current) return;
    setPhase(nextPhase);
  };

  const markConnected = () => {
    if (!mountedRef.current) return;
    setConnection("ok");
  };

  const markDisconnected = () => {
    if (!mountedRef.current) return;
    setConnection("error");
  };

  const setTaskId = (taskId?: string) => {
    if (!mountedRef.current) return;
    setActiveTaskId(taskId);
  };

  const withConnectionTracking = async <T,>(operation: () => Promise<T>): Promise<T> => {
    try {
      const result = await operation();
      markConnected();
      return result;
    } catch (error) {
      markDisconnected();
      throw error;
    }
  };

  useEffect(() => {
    mountedRef.current = true;

    void (async () => {
      try {
        const health = await withConnectionTracking(() => client.getHealth());
        const remoteAgentName = health.name?.trim();
        if (remoteAgentName) {
          setAgentName(remoteAgentName);
        }
      } catch {
        // Keep startup non-blocking; errors are surfaced on demand.
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [client]);

  useEffect(() => {
    if (isBusy && focusTarget !== "answer") {
      setFocusTarget("answer");
    }
  }, [focusTarget, isBusy]);

  useEffect(() => {
    setMainPanelContent((prev) => {
      if (prev.kind !== "empty" || prev.sourceLabel !== "startup") {
        return prev;
      }
      return createInitialMainPanelContent(agentName);
    });
  }, [agentName]);

  const presentError = (title: string, errorText: string, sourceLabel?: string) => {
    setMainPanelContentSafe({
      kind: "error",
      title,
      body: errorText,
      sourceLabel,
    });
  };

  const runSlashCommand = async (command: string): Promise<void> => {
    appendLog("command", command);

    if (command === "/help") {
      setMainPanelContentSafe({
        kind: "system",
        title: "Help",
        body: helpText,
        sourceLabel: command,
      });
      appendLog("system", "Help displayed");
      return;
    }

    if (command === "/exit") {
      renderer.destroy();
      return;
    }

    if (command !== "/messages" && command !== "/context") {
      const message = `Unknown command: ${command}`;
      appendLog("error", message);
      presentError("Command Error", message, command);
      return;
    }

    if (phaseRef.current !== "idle") {
      const message = "A task is already running. Please wait.";
      appendLog("error", message);
      presentError("Busy", message, command);
      return;
    }

    setClientPhase("submitting");
    setTaskId(undefined);

    try {
      if (command === "/messages") {
        const data = await withConnectionTracking(() => client.getAgentMessages());
        const body = formatJson(data.messages);
        setMainPanelContentSafe({
          kind: "system",
          title: "Agent Messages Snapshot",
          body,
          sourceLabel: command,
        });
        appendLog("system", `/messages loaded (${data.messages.length} messages)`);
      } else {
        const data = await withConnectionTracking(() => client.getAgentContext());
        const body = formatJson(data.context);
        setMainPanelContentSafe({
          kind: "system",
          title: "Agent Context Snapshot",
          body,
          sourceLabel: command,
        });
        appendLog("system", "/context loaded");
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      appendLog("error", summarizeEventText(`${command} failed: ${message}`));
      presentError("Command Error", `${command}\n\n${message}`, command);
    } finally {
      setClientPhase("idle");
    }
  };

  const runPromptTask = async (question: string): Promise<void> => {
    if (phaseRef.current !== "idle") {
      const message = "A task is already running. Please wait.";
      appendLog("error", message);
      presentError("Busy", message, "submit");
      return;
    }

    appendLog("user", question);
    setClientPhase("submitting");
    setTaskId(undefined);

    try {
      const created = await withConnectionTracking(() =>
        client.createTask({
          type: "tui.input",
          input: question,
        }),
      );

      if (!mountedRef.current) return;

      setTaskId(created.taskId);
      appendLog("system", `Task created: ${created.taskId}`);
      setClientPhase("polling");

      while (mountedRef.current) {
        const status = await withConnectionTracking(() => client.getTask(created.taskId));
        const task = status.task;

        if (task.status === TaskStatus.Pending || task.status === TaskStatus.Running) {
          await sleep(pollIntervalMs);
          continue;
        }

        if (task.status === TaskStatus.Success) {
          if (task.result !== undefined) {
            setMainPanelContentSafe({
              kind: "assistant",
              title: "Latest Reply",
              body: task.result,
              sourceLabel: created.taskId,
            });
            appendLog("assistant", `Reply received (${task.result.length} chars)`);
          } else {
            const message = "Task succeeded with empty result.";
            setMainPanelContentSafe({
              kind: "system",
              title: "Empty Result",
              body: message,
              sourceLabel: created.taskId,
            });
            appendLog("system", message);
          }
        } else if (task.status === TaskStatus.Failed) {
          const message = task.error?.message ?? "Unknown error";
          appendLog("error", `Task failed: ${message}`);
          presentError("Task Failed", `${created.taskId}\n\n${message}`, created.taskId);
        } else if (task.status === TaskStatus.Cancelled) {
          const message = "Task was cancelled.";
          appendLog("system", message);
          setMainPanelContentSafe({
            kind: "system",
            title: "Task Cancelled",
            body: `${created.taskId}\n\n${message}`,
            sourceLabel: created.taskId,
          });
        } else {
          const message = `Task completed with unexpected status: ${task.status}`;
          appendLog("system", message);
          setMainPanelContentSafe({
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
      appendLog("error", `Request failed: ${message}`);
      presentError("Request Error", message, "submit");
    } finally {
      setTaskId(undefined);
      setClientPhase("idle");
    }
  };

  const handleSubmit = (rawValue: string) => {
    if (isBusy || effectiveFocus !== "input") {
      return;
    }

    const value = rawValue.trim();
    setInputValue("");

    if (!value) return;

    if (value.startsWith("/")) {
      void runSlashCommand(value);
      return;
    }

    void runPromptTask(value);
  };

  useKeyboard((key) => {
    if (key.eventType !== "press") {
      return;
    }

    if (key.name === "tab") {
      if (isBusy) {
        setFocusTarget("answer");
      } else {
        setFocusTarget((prev) => (prev === "input" ? "answer" : "input"));
      }
      return;
    }

    if ((key.name === "enter" || key.name === "return") && !key.ctrl && !key.meta) {
      if (effectiveFocus === "input" && !isBusy) {
        handleSubmit(inputValue);
      }
    }
  });

  return (
    <box flexDirection="column" height={terminal.rows} width={terminal.columns}>
      <AnswerPane
        height={layout.answerHeight}
        terminalWidth={terminal.columns}
        mainPanel={mainPanelContent}
        focus={effectiveFocus}
        agentName={agentName}
      />

      {layout.showEventStrip ? (
        <box width="100%">
          <SystemStatusStrip
            height={layout.eventStripHeight}
            terminalWidth={terminal.columns}
            visibleRows={layout.eventRows}
            mode={mode}
            serverUrl={serverUrl}
            connection={connection}
            phase={phase}
            activeTaskId={activeTaskId}
            focus={effectiveFocus}
            terminal={terminal}
            layoutMode={layout.mode}
            mainPanel={mainPanelContent}
          />
        </box>
      ) : null}

      <box width="100%">
        <InputPane
          height={layout.inputHeight}
          isBusy={isBusy}
          focus={effectiveFocus}
          inputValue={inputValue}
          onChange={setInputValue}
          showHint={layout.showInputHint}
          agentName={agentName}
        />
      </box>
    </box>
  );
};

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

  const root = createRoot(renderer);

  try {
    root.render(
      <TuiApp
        client={client}
        pollIntervalMs={pollIntervalMs}
        serverUrl={serverUrl}
        mode={mode}
        agentName={agentName}
      />,
    );
    await waitForExit;
  } catch (error) {
    renderer.destroy();
    throw error;
  }
};
