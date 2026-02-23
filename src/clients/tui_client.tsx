import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";

import { sleep } from "bun";

import type { GatewayClient } from "../libs/channel/channel";
import { TaskStatus } from "../types/task";

type StartTuiClientOptions = {
  client: GatewayClient;
  pollIntervalMs?: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui";
};

type ClientPhase = "idle" | "submitting" | "polling";
type ConnectionState = "unknown" | "ok" | "error";
type LogKind = "system" | "user" | "assistant" | "error" | "command";

type LogEntry = {
  id: number;
  kind: LogKind;
  text: string;
};

type TuiAppProps = {
  client: GatewayClient;
  pollIntervalMs: number;
  serverUrl?: string;
  mode?: "hybrid" | "tui";
};

const MAX_RENDER_ENTRIES = 200;

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
  },
];

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

const helpText = [
  "Available commands:",
  "/help     Show this help",
  "/messages Show agent messages snapshot",
  "/context  Show agent context snapshot",
  "/exit     Exit TUI",
].join("\n");

const StatusLine = (props: {
  mode?: "hybrid" | "tui";
  serverUrl?: string;
  connection: ConnectionState;
  phase: ClientPhase;
  activeTaskId?: string;
}) => {
  const { mode, serverUrl, connection, phase, activeTaskId } = props;

  const connectionColor =
    connection === "ok" ? "green" : connection === "error" ? "red" : "yellow";
  const phaseColor =
    phase === "idle" ? "green" : phase === "polling" ? "yellow" : "cyan";

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text>
        <Text color="cyan">mode</Text>: {mode ?? "tui"}{"  "}
        <Text color="cyan">server</Text>: {serverUrl ?? "(unknown)"}{"  "}
        <Text color="cyan">conn</Text>:{" "}
        <Text color={connectionColor}>{connection}</Text>{"  "}
        <Text color="cyan">state</Text>: <Text color={phaseColor}>{phase}</Text>
        {activeTaskId ? (
          <>
            {"  "}
            <Text color="cyan">task</Text>: {activeTaskId}
          </>
        ) : null}
      </Text>
    </Box>
  );
};

const LogLine = ({ entry }: { entry: LogEntry }) => (
  <Box marginBottom={1}>
    <Text color={getKindColor(entry.kind)}>
      [{getKindPrefix(entry.kind)}] {entry.text}
    </Text>
  </Box>
);

const TuiApp = ({ client, pollIntervalMs, serverUrl, mode }: TuiAppProps) => {
  const { exit } = useApp();

  const [inputValue, setInputValue] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>(() => createInitialEntries());
  const [phase, setPhase] = useState<ClientPhase>("idle");
  const [connection, setConnection] = useState<ConnectionState>("unknown");
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);

  const mountedRef = useRef(true);
  const nextLogIdRef = useRef(2);
  const phaseRef = useRef<ClientPhase>("idle");

  const appendLog = (kind: LogKind, text: string) => {
    if (!mountedRef.current) return;

    setEntries((prev) => [
      ...prev,
      {
        id: nextLogIdRef.current++,
        kind,
        text,
      },
    ]);
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

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      exit();
    }
  });

  const isBusy = phase !== "idle";

  const runSlashCommand = async (command: string): Promise<void> => {
    appendLog("command", command);

    if (command === "/help") {
      appendLog("system", helpText);
      return;
    }

    if (command === "/exit") {
      exit();
      return;
    }

    if (command !== "/messages" && command !== "/context") {
      appendLog("error", `Unknown command: ${command}`);
      return;
    }

    if (phaseRef.current !== "idle") {
      appendLog("error", "A task is already running. Please wait.");
      return;
    }

    setClientPhase("submitting");
    setTaskId(undefined);

    try {
      if (command === "/messages") {
        const data = await withConnectionTracking(() => client.getAgentMessages());
        appendLog("system", formatJson(data.messages));
      } else {
        const data = await withConnectionTracking(() => client.getAgentContext());
        appendLog("system", formatJson(data.context));
      }
    } catch (error) {
      appendLog("error", formatErrorMessage(error));
    } finally {
      setClientPhase("idle");
    }
  };

  const runPromptTask = async (question: string): Promise<void> => {
    if (phaseRef.current !== "idle") {
      appendLog("error", "A task is already running. Please wait.");
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
            appendLog("assistant", task.result);
          } else {
            appendLog("system", "Task succeeded with empty result.");
          }
        } else if (task.status === TaskStatus.Failed) {
          appendLog("error", task.error?.message ?? "Unknown error");
        } else if (task.status === TaskStatus.Cancelled) {
          appendLog("system", "Task was cancelled.");
        } else {
          appendLog("system", `Task completed with unexpected status: ${task.status}`);
        }

        break;
      }
    } catch (error) {
      appendLog("error", formatErrorMessage(error));
    } finally {
      setTaskId(undefined);
      setClientPhase("idle");
    }
  };

  const handleSubmit = (rawValue: string) => {
    const value = rawValue.trim();
    setInputValue("");

    if (!value) return;

    if (value.startsWith("/")) {
      void runSlashCommand(value);
      return;
    }

    void runPromptTask(value);
  };

  const visibleEntries = entries.slice(-MAX_RENDER_ENTRIES);

  return (
    <Box flexDirection="column">
      <StatusLine
        mode={mode}
        serverUrl={serverUrl}
        connection={connection}
        phase={phase}
        activeTaskId={activeTaskId}
      />

      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        <Text dimColor>
          Conversation (showing last {Math.min(entries.length, MAX_RENDER_ENTRIES)} of{" "}
          {entries.length})
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {visibleEntries.map((entry) => (
            <LogLine key={entry.id} entry={entry} />
          ))}
        </Box>
      </Box>

      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        <Text dimColor>
          {isBusy
            ? "Task in progress... input is locked until current request finishes."
            : "Enter to submit. Use /help for commands."}
        </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          placeholder={isBusy ? "Waiting for task completion..." : "Ask Atom or type /help"}
          focus={!isBusy}
          showCursor={!isBusy}
        />
      </Box>
    </Box>
  );
};

export const startTuiClient = async (
  options: StartTuiClientOptions,
): Promise<void> => {
  const { client, pollIntervalMs = 500, serverUrl, mode } = options;

  const instance = render(
    <TuiApp
      client={client}
      pollIntervalMs={pollIntervalMs}
      serverUrl={serverUrl}
      mode={mode}
    />,
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
