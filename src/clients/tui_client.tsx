import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";

import { sleep } from "bun";

import type { GatewayClient } from "../libs/channel/channel";
import { TaskStatus } from "../types/task";

type StartTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs?: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui" | "tui-client";
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

type ViewportState = {
  scrollOffset: number;
  viewportHeight: number;
  contentWidth: number;
  wrappedLinesCount: number;
  maxScrollOffset: number;
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
};

type ScrollbarThumb = {
  visible: boolean;
  start: number;
  size: number;
};

const MAX_RENDER_ENTRIES = 200;
const MIN_TERMINAL_COLUMNS = 20;
const MIN_TERMINAL_ROWS = 8;
const ANSWER_PANEL_VERTICAL_OVERHEAD = 4; // border(2) + title(1) + status(1)
const ANSWER_PANEL_HORIZONTAL_OVERHEAD = 6; // border(2) + paddingX(2) + gap+scrollbar(2)
const PANEL_INNER_HORIZONTAL_OVERHEAD = 4; // border(2) + paddingX(2)
const ELLIPSIS = "...";

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
    text: "Ink TUI ready. Type /help to see commands.",
    createdAt: Date.now(),
  },
];

const createInitialMainPanelContent = (): MainPanelContent => ({
  kind: "empty",
  title: "Ready",
  sourceLabel: "startup",
  body: [
    "Atom TUI is ready.",
    "",
    "Shortcuts:",
    "  Tab              Switch focus (Input / Answer)",
    "  j / k, Up / Down Scroll answer content",
    "  PageUp / PageDown Scroll faster",
    "  Home / End       Jump to top / bottom",
    "  Ctrl+C           Exit",
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

const getKindPrefix = (kind: LogKind): string => {
  switch (kind) {
    case "user":
      return "You";
    case "assistant":
      return "Atom";
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

export const summarizeEventText = (text: string, maxWidth = 80): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(empty)";
  return truncateToDisplayWidth(singleLine, maxWidth);
};

export const wrapContentToLines = (text: string, width: number): string[] => {
  const safeWidth = Math.max(1, Math.floor(width));
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    const expanded = rawLine.replace(/\t/g, "  ");

    if (expanded.length === 0) {
      wrapped.push("");
      continue;
    }

    let buffer = "";
    let bufferWidth = 0;

    for (const char of Array.from(expanded)) {
      const charWidth = Math.max(1, charDisplayWidth(char));

      if (bufferWidth + charWidth > safeWidth && buffer.length > 0) {
        wrapped.push(buffer);
        buffer = "";
        bufferWidth = 0;
      }

      if (charWidth > safeWidth && buffer.length === 0) {
        wrapped.push(char);
        continue;
      }

      buffer += char;
      bufferWidth += charWidth;
    }

    if (buffer.length > 0) {
      wrapped.push(buffer);
    }
  }

  return wrapped.length > 0 ? wrapped : [""];
};

export const clampScrollOffset = (
  offset: number,
  wrappedLinesCount: number,
  viewportHeight: number,
): number => {
  const safeViewport = Math.max(1, Math.floor(viewportHeight));
  const safeTotal = Math.max(0, Math.floor(wrappedLinesCount));
  const maxOffset = Math.max(0, safeTotal - safeViewport);
  const safeOffset = Math.floor(Number.isFinite(offset) ? offset : 0);
  return Math.max(0, Math.min(safeOffset, maxOffset));
};

export const computeScrollbarThumb = (
  wrappedLinesCount: number,
  viewportHeight: number,
  scrollOffset: number,
): ScrollbarThumb => {
  const safeViewport = Math.max(1, Math.floor(viewportHeight));
  const safeTotal = Math.max(0, Math.floor(wrappedLinesCount));

  if (safeTotal <= safeViewport) {
    return { visible: false, start: 0, size: safeViewport };
  }

  const maxOffset = Math.max(0, safeTotal - safeViewport);
  const clampedOffset = clampScrollOffset(scrollOffset, safeTotal, safeViewport);
  const thumbSize = Math.max(1, Math.min(safeViewport, Math.floor((safeViewport * safeViewport) / safeTotal)));
  const maxStart = Math.max(0, safeViewport - thumbSize);
  const thumbStart = maxOffset === 0 ? 0 : Math.round((clampedOffset / maxOffset) * maxStart);

  return {
    visible: true,
    start: thumbStart,
    size: thumbSize,
  };
};

const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout();

  const getSize = (): TerminalSize => ({
    columns: Math.max(MIN_TERMINAL_COLUMNS, toSafeNumber(stdout.columns, 80)),
    rows: Math.max(MIN_TERMINAL_ROWS, toSafeNumber(stdout.rows, 24)),
  });

  const [size, setSize] = useState<TerminalSize>(() => getSize());

  useEffect(() => {
    setSize(getSize());

    const onResize = () => {
      setSize(getSize());
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
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
): string => {
  const source = mainPanel.sourceLabel ? ` | ${mainPanel.sourceLabel}` : "";
  const raw = `Atom Answer Zone | ${mainPanel.title}${source}`;
  return truncateToDisplayWidth(raw, headerWidth);
};

const buildAgentMetaLine = (props: {
  mainPanel: MainPanelContent;
  viewport: ViewportState;
  compact: boolean;
}): string => {
  const { mainPanel, viewport, compact } = props;
  const scrollText = `${viewport.scrollOffset}/${viewport.maxScrollOffset}`;
  const sourceText = mainPanel.sourceLabel
    ? truncateToDisplayWidth(mainPanel.sourceLabel, compact ? 12 : 20)
    : "-";

  if (compact) {
    return `type:${mainPanel.kind} src:${sourceText} scroll:${scrollText}`;
  }

  return `type:${mainPanel.kind} source:${sourceText} scroll:${scrollText} lines:${viewport.wrappedLinesCount}`;
};

const AnswerPane = (props: {
  height: number;
  terminalWidth: number;
  mainPanel: MainPanelContent;
  focus: FocusTarget;
  viewport: ViewportState;
  visibleLines: string[];
}) => {
  const {
    height,
    terminalWidth,
    mainPanel,
    focus,
    viewport,
    visibleLines,
  } = props;

  const headerWidth = Math.max(1, terminalWidth - PANEL_INNER_HORIZONTAL_OVERHEAD);
  const titleLine = buildAnswerTitleLine(mainPanel, headerWidth);
  const statusLine = truncateToDisplayWidth(
    buildAgentMetaLine({
      mainPanel,
      viewport,
      compact: terminalWidth < 50,
    }),
    headerWidth,
  );
  const scrollbarThumb = computeScrollbarThumb(
    viewport.wrappedLinesCount,
    viewport.viewportHeight,
    viewport.scrollOffset,
  );
  const contentColor = getMainPanelColor(mainPanel.kind);
  const paddedLines = [...visibleLines];
  while (paddedLines.length < viewport.viewportHeight) {
    paddedLines.push("");
  }

  return (
    <Box
      borderStyle="single"
      borderColor={focus === "answer" ? "cyan" : "gray"}
      paddingX={1}
      flexDirection="column"
      height={height}
      width="100%"
    >
      <Text color="cyan">{titleLine || "Atom Answer Zone"}</Text>
      <Text dimColor>{statusLine || "status unavailable"}</Text>
      <Box flexDirection="row" height={Math.max(1, viewport.viewportHeight)}>
        <Box flexDirection="column" flexGrow={1} width="100%">
          {paddedLines.map((line, index) => (
            <Text key={`answer-line-${index}`} color={contentColor} dimColor={mainPanel.kind === "empty"}>
              {line.length > 0 ? line : " "}
            </Text>
          ))}
        </Box>
        <Box width={1} marginLeft={1} flexDirection="column">
          {Array.from({ length: Math.max(1, viewport.viewportHeight) }, (_, index) => {
            const isThumb =
              scrollbarThumb.visible && index >= scrollbarThumb.start && index < scrollbarThumb.start + scrollbarThumb.size;
            return (
              <Text
                key={`scrollbar-${index}`}
                color={isThumb ? (focus === "answer" ? "cyan" : "white") : "gray"}
              >
                {isThumb ? "#" : "|"}
              </Text>
            );
          })}
        </Box>
      </Box>
    </Box>
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
  viewport: ViewportState;
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
    viewport,
    mainPanel,
  } = props;
  const rowWidth = Math.max(1, terminalWidth - PANEL_INNER_HORIZONTAL_OVERHEAD);
  const displayMode = mode === "hybrid" ? "tui" : (mode ?? "tui");
  const rows = [
    `mode:${displayMode}  layout:${layoutMode}  conn:${connection}  state:${phase}`,
    `server:${serverUrl ?? "(unknown)"}${activeTaskId ? `  task:${activeTaskId}` : ""}`,
    `term:${terminal.columns}x${terminal.rows}  focus:${focus}  scroll:${viewport.scrollOffset}/${viewport.maxScrollOffset}  lines:${viewport.wrappedLinesCount}`,
    `panel:${mainPanel.kind}  title:${mainPanel.title}${mainPanel.sourceLabel ? `  src:${mainPanel.sourceLabel}` : ""}`,
  ]
    .slice(0, Math.max(0, visibleRows))
    .map((line) => truncateToDisplayWidth(line, rowWidth));

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      height={height}
      width="100%"
    >
      <Text color="cyan">System Status</Text>
      {Array.from({ length: visibleRows }, (_, index) => {
        const line = rows[index];
        if (!line) {
          return (
            <Box key={`status-empty-${index}`} width="100%">
              <Text> </Text>
            </Box>
          );
        }

        return (
          <Box key={`status-line-${index}`} width="100%">
            <Text color="gray">{line.length > 0 ? line : " "}</Text>
          </Box>
        );
      })}
    </Box>
  );
};

const InputPane = (props: {
  height: number;
  isBusy: boolean;
  focus: FocusTarget;
  inputValue: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  showHint: boolean;
}) => {
  const { height, isBusy, focus, inputValue, onChange, onSubmit, showHint } = props;
  const inputFocused = !isBusy && focus === "input";

  return (
    <Box
      borderStyle="single"
      borderColor={inputFocused ? "cyan" : "gray"}
      paddingX={1}
      flexDirection="column"
      height={height}
      width="100%"
    >
      <Text color="cyan">User Input Zone</Text>
      {showHint ? (
        <Text dimColor>
          {isBusy
            ? "Task in progress... input is locked; switch to answer view to scroll."
            : "Enter to submit. Tab switches focus."}
        </Text>
      ) : null}
      <Box width="100%">
        <TextInput
          value={inputValue}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={isBusy ? "Waiting for task completion..." : "Ask Atom or type /help"}
          focus={inputFocused}
          showCursor={inputFocused}
        />
      </Box>
    </Box>
  );
};

const TuiApp = ({ client, pollIntervalMs, serverUrl, mode }: TuiAppProps) => {
  const { exit } = useApp();

  const terminal = useTerminalSize();

  const [inputValue, setInputValue] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>(() => createInitialEntries());
  const [mainPanelContent, setMainPanelContent] = useState<MainPanelContent>(() =>
    createInitialMainPanelContent(),
  );
  const [phase, setPhase] = useState<ClientPhase>("idle");
  const [connection, setConnection] = useState<ConnectionState>("unknown");
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>("input");
  const [scrollOffset, setScrollOffset] = useState(0);

  const mountedRef = useRef(true);
  const nextLogIdRef = useRef(2);
  const phaseRef = useRef<ClientPhase>("idle");

  const layout = getLayoutMetrics(terminal);
  const answerViewportHeight = Math.max(1, layout.answerHeight - ANSWER_PANEL_VERTICAL_OVERHEAD);
  const answerContentWidth = Math.max(1, terminal.columns - ANSWER_PANEL_HORIZONTAL_OVERHEAD);
  const wrappedLines = wrapContentToLines(mainPanelContent.body, answerContentWidth);
  const clampedOffset = clampScrollOffset(scrollOffset, wrappedLines.length, answerViewportHeight);
  const maxScrollOffset = Math.max(0, wrappedLines.length - answerViewportHeight);
  const viewport: ViewportState = {
    scrollOffset: clampedOffset,
    viewportHeight: answerViewportHeight,
    contentWidth: answerContentWidth,
    wrappedLinesCount: wrappedLines.length,
    maxScrollOffset,
  };
  const visibleAnswerLines = wrappedLines.slice(
    viewport.scrollOffset,
    viewport.scrollOffset + viewport.viewportHeight,
  );

  const isBusy = phase !== "idle";
  const effectiveFocus: FocusTarget = isBusy ? "answer" : focusTarget;

  useEffect(() => {
    if (clampedOffset !== scrollOffset) {
      setScrollOffset(clampedOffset);
    }
  }, [clampedOffset, scrollOffset]);

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

  const setMainPanelContentAndResetScroll = (next: MainPanelContent) => {
    if (!mountedRef.current) return;
    setMainPanelContent(next);
    setScrollOffset(0);
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
        await withConnectionTracking(() => client.getHealth());
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

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      exit();
      return;
    }

    if (key.tab) {
      if (isBusy) {
        setFocusTarget("answer");
      } else {
        setFocusTarget((prev) => (prev === "input" ? "answer" : "input"));
      }
      return;
    }

    if (effectiveFocus !== "answer") {
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    const pageStep = Math.max(1, viewport.viewportHeight - 1);

    const scrollBy = (delta: number) => {
      setScrollOffset((prev) =>
        clampScrollOffset(prev + delta, viewport.wrappedLinesCount, viewport.viewportHeight),
      );
    };

    if (key.upArrow || input === "k") {
      scrollBy(-1);
      return;
    }

    if (key.downArrow || input === "j") {
      scrollBy(1);
      return;
    }

    if (key.pageUp) {
      scrollBy(-pageStep);
      return;
    }

    if (key.pageDown) {
      scrollBy(pageStep);
      return;
    }

    if (key.home) {
      setScrollOffset(0);
      return;
    }

    if (key.end) {
      setScrollOffset(clampScrollOffset(Number.MAX_SAFE_INTEGER, viewport.wrappedLinesCount, viewport.viewportHeight));
    }
  });

  const presentError = (title: string, errorText: string, sourceLabel?: string) => {
    setMainPanelContentAndResetScroll({
      kind: "error",
      title,
      body: errorText,
      sourceLabel,
    });
  };

  const runSlashCommand = async (command: string): Promise<void> => {
    appendLog("command", command);

    if (command === "/help") {
      setMainPanelContentAndResetScroll({
        kind: "system",
        title: "Help",
        body: helpText,
        sourceLabel: command,
      });
      appendLog("system", "Help displayed");
      return;
    }

    if (command === "/exit") {
      exit();
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
        setMainPanelContentAndResetScroll({
          kind: "system",
          title: "Agent Messages Snapshot",
          body,
          sourceLabel: command,
        });
        appendLog("system", `/messages loaded (${data.messages.length} messages)`);
      } else {
        const data = await withConnectionTracking(() => client.getAgentContext());
        const body = formatJson(data.context);
        setMainPanelContentAndResetScroll({
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
            setMainPanelContentAndResetScroll({
              kind: "assistant",
              title: "Latest Reply",
              body: task.result,
              sourceLabel: created.taskId,
            });
            appendLog("assistant", `Reply received (${task.result.length} chars)`);
          } else {
            const message = "Task succeeded with empty result.";
            setMainPanelContentAndResetScroll({
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
          setMainPanelContentAndResetScroll({
            kind: "system",
            title: "Task Cancelled",
            body: `${created.taskId}\n\n${message}`,
            sourceLabel: created.taskId,
          });
        } else {
          const message = `Task completed with unexpected status: ${task.status}`;
          appendLog("system", message);
          setMainPanelContentAndResetScroll({
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

  return (
    <Box flexDirection="column" height={terminal.rows} width={terminal.columns}>
      <AnswerPane
        height={layout.answerHeight}
        terminalWidth={terminal.columns}
        mainPanel={mainPanelContent}
        focus={effectiveFocus}
        viewport={viewport}
        visibleLines={visibleAnswerLines}
      />

      {layout.showEventStrip ? (
        <Box width="100%">
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
            viewport={viewport}
            mainPanel={mainPanelContent}
          />
        </Box>
      ) : null}

      <Box width="100%">
        <InputPane
          height={layout.inputHeight}
          isBusy={isBusy}
          focus={effectiveFocus}
          inputValue={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          showHint={layout.showInputHint}
        />
      </Box>
    </Box>
  );
};

export const startTuiClient = async (options: StartTuiClientOptions): Promise<void> => {
  const { client, pollIntervalMs = 500, serverUrl, mode } = options;

  const instance = render(
    <TuiApp client={client} pollIntervalMs={pollIntervalMs} serverUrl={serverUrl} mode={mode} />,
    {
      patchConsole: true,
      exitOnCtrlC: true,
      incrementalRendering: true,
    },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
  }
};
