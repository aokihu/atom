import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkTmuxAvailable,
  getBashStateDir,
  shellSingleQuote,
  toTmuxSessionName,
  type BashOutputEvent,
} from "./bash_utils";

export type BackgroundSessionMetadata = {
  sessionId: string;
  mode: "background";
  cwd: string;
  command: string;
  tmuxSessionName: string;
  startedAt: number;
  updatedAt?: number;
  endedAt?: number;
  statusHint?: "running" | "killed" | "exited" | "unknown";
  exitCode?: number;
  reason?: string;
  logFile: string;
  cmdScriptFile: string;
  runnerScriptFile: string;
};

type BackgroundStatusInfo = {
  status: "running" | "exited" | "killed" | "unknown";
  exitCode?: number;
  reason?: string;
  warning?: string;
  endedAt?: number;
};

const LOG_VERSION = "v1";

const getSessionPaths = (workspace: string, sessionId: string) => {
  const dir = getBashStateDir(workspace);
  return {
    dir,
    metadataFile: join(dir, `${sessionId}.json`),
    logFile: join(dir, `${sessionId}.log`),
    cmdScriptFile: join(dir, `${sessionId}.cmd.sh`),
    runnerScriptFile: join(dir, `${sessionId}.runner.sh`),
    eventFifoFile: join(dir, `${sessionId}.events.fifo`),
  };
};

const runCommand = async (args: string[], cwd?: string) => {
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

const fileExists = async (filepath: string) => {
  try {
    await stat(filepath);
    return true;
  } catch {
    return false;
  }
};

const readMetadata = async (workspace: string, sessionId: string) => {
  const { metadataFile } = getSessionPaths(workspace, sessionId);
  if (!(await fileExists(metadataFile))) {
    return null;
  }

  try {
    const text = await readFile(metadataFile, "utf8");
    const parsed = JSON.parse(text) as BackgroundSessionMetadata;
    if (!parsed || typeof parsed !== "object") {
      return { error: "Invalid background session metadata" } as const;
    }
    return parsed;
  } catch {
    return { error: "Invalid background session metadata" } as const;
  }
};

const writeMetadata = async (metadata: BackgroundSessionMetadata) => {
  await mkdir(dirname(metadata.logFile), { recursive: true });
  await writeFile(metadataFilePath(metadata), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
};

const metadataFilePath = (metadata: BackgroundSessionMetadata) =>
  join(dirname(metadata.logFile), `${metadata.sessionId}.json`);

const buildCommandScript = (command: string) => `#!/usr/bin/env bash
set -o pipefail
${command}
`;

const buildRunnerScript = (metadata: BackgroundSessionMetadata, eventFifoFile: string) => {
  const logFile = shellSingleQuote(metadata.logFile);
  const cmdFile = shellSingleQuote(metadata.cmdScriptFile);
  const cwd = shellSingleQuote(metadata.cwd);
  const fifo = shellSingleQuote(eventFifoFile);

  return `#!/usr/bin/env bash
set -uo pipefail

LOG_FILE=${logFile}
CMD_FILE=${cmdFile}
CWD=${cwd}
EVENT_FIFO=${fifo}

ts_ms() {
  local s
  s="$(date +%s 2>/dev/null || echo 0)"
  printf '%s000' "$s"
}

b64() {
  printf '%s' "$1" | base64 | tr -d '\\n'
}

append_log_line() {
  local seq="$1"
  local ts="$2"
  local stream="$3"
  local payload="$4"
  printf '${LOG_VERSION}\\t%s\\t%s\\t%s\\t%s\\n' "$seq" "$ts" "$stream" "$payload" >> "$LOG_FILE"
}

cleanup() {
  exec 3>&- 2>/dev/null || true
  rm -f "$EVENT_FIFO" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"
rm -f "$EVENT_FIFO" 2>/dev/null || true
mkfifo "$EVENT_FIFO"

(
  seq_no=0
  while IFS=$'\\t' read -r stream payload || [ -n "\${stream:-}" ]; do
    [ -z "\${stream:-}" ] && continue
    seq_no=$((seq_no + 1))
    append_log_line "$seq_no" "$(ts_ms)" "$stream" "$payload"
  done < "$EVENT_FIFO"
) &
AGG_PID=$!

exec 3>"$EVENT_FIFO"

send_event() {
  local stream="$1"
  local text="$2"
  printf '%s\\t%s\\n' "$stream" "$(b64 "$text")" >&3
}

send_event meta "start"

(
  cd "$CWD" || { send_event meta "cwd-error"; exit 111; }
  bash "$CMD_FILE" \\
    > >(while IFS= read -r line || [ -n "$line" ]; do printf 'stdout\\t%s\\n' "$(b64 "$line")" >&3; done) \\
    2> >(while IFS= read -r line || [ -n "$line" ]; do printf 'stderr\\t%s\\n' "$(b64 "$line")" >&3; done)
)
EXIT_CODE=$?

send_event meta "exit:$EXIT_CODE"
exec 3>&-
wait "$AGG_PID" 2>/dev/null || true
exit "$EXIT_CODE"
`;
};

const tmuxSessionExists = async (tmuxSessionName: string) => {
  const result = await runCommand(["tmux", "has-session", "-t", tmuxSessionName]);
  return result.ok;
};

type ParsedLogChunk = {
  items: BashOutputEvent[];
  nextOffset: number;
};

const parseLogLine = (line: string): BashOutputEvent | null => {
  const parts = line.split("\t");
  if (parts.length !== 5) return null;
  const [version, seqText, tsText, stream, payload] = parts;
  if (version !== LOG_VERSION) return null;
  if (stream !== "stdout" && stream !== "stderr" && stream !== "meta") return null;
  if (payload === undefined) return null;

  const seq = Number(seqText);
  const at = Number(tsText);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  if (!Number.isFinite(at) || at < 0) return null;

  let text = "";
  try {
    text = Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return null;
  }

  return {
    seq,
    stream,
    text,
    at,
  };
};

const parseLogChunk = (text: string, offset: number, maxItems: number): ParsedLogChunk => {
  let cursor = Math.max(0, Math.min(offset, text.length));
  const items: BashOutputEvent[] = [];

  while (items.length < maxItems) {
    const newlineIndex = text.indexOf("\n", cursor);
    if (newlineIndex < 0) {
      break;
    }

    const line = text.slice(cursor, newlineIndex);
    cursor = newlineIndex + 1;
    if (line.length === 0) continue;

    const parsed = parseLogLine(line);
    if (parsed) {
      items.push(parsed);
    }
  }

  return {
    items,
    nextOffset: cursor,
  };
};

const readLogText = async (logFile: string): Promise<string> => {
  if (!(await fileExists(logFile))) {
    return "";
  }
  return readFile(logFile, "utf8");
};

const inferStatusFromMetadataAndLog = async (
  metadata: BackgroundSessionMetadata,
): Promise<BackgroundStatusInfo> => {
  const tmuxAvailable = await checkTmuxAvailable();
  let tmuxRunning = false;
  let warning: string | undefined;

  if (tmuxAvailable) {
    tmuxRunning = await tmuxSessionExists(metadata.tmuxSessionName);
  } else {
    warning = "tmux command is not available in runtime environment";
  }

  if (tmuxRunning) {
    return {
      status: "running",
      reason: metadata.reason,
      warning,
    };
  }

  const logText = await readLogText(metadata.logFile);
  let lastMeta: BashOutputEvent | undefined;
  if (logText.length > 0) {
    const all = parseLogChunk(logText, 0, Number.MAX_SAFE_INTEGER).items;
    for (const item of all) {
      if (item.stream === "meta") {
        lastMeta = item;
      }
    }
  }

  if (lastMeta?.text.startsWith("exit:")) {
    const exitCodeValue = Number(lastMeta.text.slice(5));
    const exitCode = Number.isFinite(exitCodeValue) ? exitCodeValue : undefined;
    if (metadata.statusHint === "killed") {
      return {
        status: "killed",
        exitCode,
        reason: metadata.reason ?? "terminated by bash tool",
        warning,
        endedAt: metadata.endedAt ?? lastMeta.at,
      };
    }

    return {
      status: "exited",
      exitCode,
      reason: metadata.reason ?? "process exited",
      warning,
      endedAt: metadata.endedAt ?? lastMeta.at,
    };
  }

  if (metadata.statusHint === "killed") {
    return {
      status: "killed",
      exitCode: metadata.exitCode,
      reason: metadata.reason ?? "terminated by bash tool",
      warning,
      endedAt: metadata.endedAt,
    };
  }

  if (metadata.statusHint === "exited") {
    return {
      status: "exited",
      exitCode: metadata.exitCode,
      reason: metadata.reason ?? "process exited",
      warning,
      endedAt: metadata.endedAt,
    };
  }

  return {
    status: "unknown",
    reason: metadata.reason ?? "tmux session not found and no exit metadata",
    warning,
    endedAt: metadata.endedAt,
  };
};

export const hasBackgroundBashSession = async (workspace: string, sessionId: string) => {
  const { metadataFile } = getSessionPaths(workspace, sessionId);
  return fileExists(metadataFile);
};

export const getBackgroundBashSessionCwd = async (workspace: string, sessionId: string) => {
  const metadata = await readMetadata(workspace, sessionId);
  if (!metadata || "error" in metadata) {
    return undefined;
  }
  return metadata.cwd;
};

export const startBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  cwd: string;
  command: string;
}) => {
  const { dir, metadataFile, logFile, cmdScriptFile, runnerScriptFile, eventFifoFile } =
    getSessionPaths(args.workspace, args.sessionId);

  await mkdir(dir, { recursive: true });
  if (await fileExists(metadataFile)) {
    return {
      error: "Session already exists",
      sessionId: args.sessionId,
      status: "failed_to_start" as const,
    };
  }

  const startedAt = Date.now();
  const metadata: BackgroundSessionMetadata = {
    sessionId: args.sessionId,
    mode: "background",
    cwd: args.cwd,
    command: args.command,
    tmuxSessionName: toTmuxSessionName(args.sessionId),
    startedAt,
    updatedAt: startedAt,
    statusHint: "running",
    logFile,
    cmdScriptFile,
    runnerScriptFile,
  };

  try {
    await writeFile(cmdScriptFile, buildCommandScript(args.command), { mode: 0o700 });
    await writeFile(runnerScriptFile, buildRunnerScript(metadata, eventFifoFile), { mode: 0o700 });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "failed to create background session files",
      sessionId: args.sessionId,
      status: "failed_to_start" as const,
    };
  }

  const tmuxStart = await runCommand([
    "tmux",
    "new-session",
    "-d",
    "-s",
    metadata.tmuxSessionName,
    `bash ${shellSingleQuote(runnerScriptFile)}`,
  ]);

  if (!tmuxStart.ok) {
    return {
      error: tmuxStart.stderr || "failed to start tmux background session",
      sessionId: args.sessionId,
      status: "failed_to_start" as const,
      stderr: tmuxStart.stderr,
      stdout: tmuxStart.stdout,
      exitCode: tmuxStart.exitCode,
    };
  }

  await writeMetadata(metadata);

  return {
    mode: "background" as const,
    sessionId: args.sessionId,
    status: "running" as const,
    cwd: args.cwd,
    command: args.command,
    startedAt,
  };
};

export const queryBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  offset: number;
  maxItems: number;
}) => {
  const metadata = await readMetadata(args.workspace, args.sessionId);
  if (!metadata) {
    return null;
  }
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      status: "unknown" as const,
    };
  }

  const logText = await readLogText(metadata.logFile);
  const offset = Math.max(0, Math.min(args.offset, logText.length));
  const { items, nextOffset } = parseLogChunk(logText, offset, args.maxItems);
  const statusInfo = await inferStatusFromMetadataAndLog(metadata);

  return {
    sessionId: metadata.sessionId,
    mode: "background" as const,
    cwd: metadata.cwd,
    command: metadata.command,
    status: statusInfo.status,
    startedAt: metadata.startedAt,
    updatedAt: metadata.updatedAt ?? metadata.startedAt,
    endedAt: statusInfo.endedAt ?? metadata.endedAt,
    exitCode: statusInfo.exitCode ?? metadata.exitCode,
    reason: statusInfo.reason ?? metadata.reason,
    items,
    nextOffset,
    done: statusInfo.status !== "running",
    warning: statusInfo.warning,
  };
};

export const killBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  force?: boolean;
}) => {
  const metadata = await readMetadata(args.workspace, args.sessionId);
  if (!metadata) {
    return null;
  }
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      success: false,
      status: "kill_failed" as const,
      requestedAt: Date.now(),
      reason: metadata.error,
    };
  }

  const requestedAt = Date.now();
  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      cwd: metadata.cwd,
      success: false,
      status: "kill_failed" as const,
      requestedAt,
      reason: "tmux command is not available in runtime environment",
      warning: "tmux command is not available in runtime environment",
    };
  }

  const running = await tmuxSessionExists(metadata.tmuxSessionName);
  if (!running) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      cwd: metadata.cwd,
      success: true,
      status: "already_exited" as const,
      requestedAt,
      reason: metadata.reason ?? "background session is not running",
    };
  }

  const result = await runCommand(["tmux", "kill-session", "-t", metadata.tmuxSessionName]);
  if (!result.ok) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      cwd: metadata.cwd,
      success: false,
      status: "kill_failed" as const,
      requestedAt,
      reason: result.stderr || "failed to kill tmux session",
      warning: args.force ? "force is ignored for tmux-backed sessions" : undefined,
    };
  }

  const updatedMetadata: BackgroundSessionMetadata = {
    ...metadata,
    updatedAt: requestedAt,
    endedAt: requestedAt,
    statusHint: "killed",
    reason: "terminated by bash tool",
  };
  await writeMetadata(updatedMetadata);

  return {
    sessionId: metadata.sessionId,
    mode: "background" as const,
    cwd: metadata.cwd,
    success: true,
    status: "killed" as const,
    requestedAt,
    reason: "tmux kill-session",
    warning: args.force ? "force is ignored for tmux-backed sessions" : undefined,
  };
};
