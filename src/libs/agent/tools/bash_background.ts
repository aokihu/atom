import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkTmuxAvailable,
  getBackgroundStateDir,
  shellSingleQuote,
  toTmuxSessionName,
  type BashOutputEvent,
} from "./bash_utils";

export type BackgroundSessionMetadata = {
  sessionId: string;
  tool: "background";
  cwd: string;
  command: string;
  tmuxSessionName: string;
  startedAt: number;
  updatedAt?: number;
  endedAt?: number;
  statusHint?: "running" | "killed" | "exited" | "unknown";
  exitCode?: number;
  reason?: string;
  primaryWindowId?: string;
  primaryPaneId?: string;
  logFile: string;
  cmdScriptFile: string;
  runnerScriptFile: string;
};

export type BackgroundStatusInfo = {
  status: "running" | "exited" | "killed" | "unknown";
  exitCode?: number;
  reason?: string;
  warning?: string;
  endedAt?: number;
};

export type BackgroundSessionSummary = {
  sessionId: string;
  status: BackgroundStatusInfo["status"];
  cwd: string;
  command: string;
  startedAt: number;
  updatedAt?: number;
  endedAt?: number;
  tmuxSessionName: string;
  primaryPaneId?: string;
  warning?: string;
};

export type BackgroundWindowInfo = {
  windowId: string;
  windowIndex: number;
  name: string;
  active: boolean;
};

export type BackgroundPaneInfo = {
  paneId: string;
  windowId: string;
  windowIndex: number;
  paneIndex: number;
  active: boolean;
  panePid?: number;
  currentCommand?: string;
  currentPath?: string;
  title?: string;
  previewText?: string;
};

const LOG_VERSION = "v1";
const DEFAULT_CAPTURE_TAIL_LINES = 200;
const MAX_CAPTURE_TAIL_LINES = 2_000;

const getSessionPaths = (workspace: string, sessionId: string) => {
  const dir = getBackgroundStateDir(workspace);
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

const removeSessionArtifacts = async (workspace: string, sessionId: string) => {
  const paths = getSessionPaths(workspace, sessionId);
  const targets = [
    paths.metadataFile,
    paths.logFile,
    paths.cmdScriptFile,
    paths.runnerScriptFile,
    paths.eventFifoFile,
  ];

  const removed: string[] = [];
  for (const target of targets) {
    try {
      await rm(target, { force: true });
      removed.push(target);
    } catch {
      // Best-effort cleanup on startup; ignore individual file errors.
    }
  }

  return removed;
};

const metadataFilePath = (metadata: BackgroundSessionMetadata) =>
  join(dirname(metadata.logFile), `${metadata.sessionId}.json`);

const normalizeParsedMetadata = (parsed: BackgroundSessionMetadata): BackgroundSessionMetadata => {
  // Backward-compat for previously written metadata during refactor stage (if any in current branch history)
  const normalized = {
    ...parsed,
    tool: "background" as const,
  };

  return normalized;
};

export const readBackgroundSessionMetadata = async (workspace: string, sessionId: string) => {
  const { metadataFile } = getSessionPaths(workspace, sessionId);
  if (!(await fileExists(metadataFile))) {
    return null;
  }

  try {
    const text = await readFile(metadataFile, "utf8");
    const parsed = JSON.parse(text) as BackgroundSessionMetadata & { mode?: string };
    if (!parsed || typeof parsed !== "object") {
      return { error: "Invalid background session metadata" } as const;
    }
    if (typeof parsed.sessionId !== "string" || typeof parsed.cwd !== "string") {
      return { error: "Invalid background session metadata" } as const;
    }
    return normalizeParsedMetadata(parsed as BackgroundSessionMetadata);
  } catch {
    return { error: "Invalid background session metadata" } as const;
  }
};

const writeMetadata = async (metadata: BackgroundSessionMetadata) => {
  await mkdir(dirname(metadata.logFile), { recursive: true });
  await writeFile(metadataFilePath(metadata), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
};

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

const trimNewline = (text: string) => text.replace(/[\r\n]+$/, "");

const tmuxSessionExists = async (tmuxSessionName: string) => {
  const result = await runCommand(["tmux", "has-session", "-t", tmuxSessionName]);
  return result.ok;
};

const setPaneTitle = async (paneId: string, title: string) =>
  runCommand(["tmux", "select-pane", "-t", paneId, "-T", title]);

const runTmuxCapturePane = async (args: {
  paneId: string;
  tailLines?: number;
  includeAnsi?: boolean;
}) => {
  const lines = Number.isInteger(args.tailLines) && (args.tailLines as number) > 0
    ? Math.min(args.tailLines as number, MAX_CAPTURE_TAIL_LINES)
    : DEFAULT_CAPTURE_TAIL_LINES;
  const commandArgs = ["tmux", "capture-pane", "-p", "-t", args.paneId];
  if (args.includeAnsi) {
    commandArgs.push("-e");
  }
  commandArgs.push("-S", `-${lines}`);
  const result = await runCommand(commandArgs);
  return {
    ...result,
    lines,
    text: result.stdout,
  };
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

  return { seq, stream, text, at };
};

const parseLogChunk = (text: string, offset: number, maxItems: number): ParsedLogChunk => {
  let cursor = Math.max(0, Math.min(offset, text.length));
  const items: BashOutputEvent[] = [];

  while (items.length < maxItems) {
    const newlineIndex = text.indexOf("\n", cursor);
    if (newlineIndex < 0) break;

    const line = text.slice(cursor, newlineIndex);
    cursor = newlineIndex + 1;
    if (line.length === 0) continue;

    const parsed = parseLogLine(line);
    if (parsed) items.push(parsed);
  }

  return { items, nextOffset: cursor };
};

const readLogText = async (logFile: string): Promise<string> => {
  if (!(await fileExists(logFile))) {
    return "";
  }
  return readFile(logFile, "utf8");
};

export const inferBackgroundStatusFromMetadataAndLog = async (
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
        reason: metadata.reason ?? "terminated by background tool",
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
      reason: metadata.reason ?? "terminated by background tool",
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
  const metadata = await readBackgroundSessionMetadata(workspace, sessionId);
  if (!metadata || "error" in metadata) {
    return undefined;
  }
  return metadata.cwd;
};

const parseStartTargetOutput = (stdout: string) => {
  const text = trimNewline(stdout);
  const parts = text.split("\t");
  if (parts.length < 5) {
    return null;
  }
  const [sessionName, windowId, paneId, windowIndexText, paneIndexText] = parts;
  const windowIndex = Number(windowIndexText);
  const paneIndex = Number(paneIndexText);
  if (
    typeof sessionName !== "string" ||
    typeof windowId !== "string" ||
    typeof paneId !== "string" ||
    !Number.isInteger(windowIndex) ||
    !Number.isInteger(paneIndex)
  ) {
    return null;
  }
  return { sessionName, windowId, paneId, windowIndex, paneIndex };
};

const parseTmuxTargetOutput = (stdout: string) => {
  const text = trimNewline(stdout);
  const parts = text.split("\t");
  if (parts.length < 4) {
    return null;
  }
  const [windowId, paneId, windowIndexText, paneIndexText] = parts;
  const windowIndex = Number(windowIndexText);
  const paneIndex = Number(paneIndexText);
  if (!windowId || !paneId || !Number.isInteger(windowIndex) || !Number.isInteger(paneIndex)) {
    return null;
  }
  return { windowId, paneId, windowIndex, paneIndex };
};

const parseTmuxBool = (value: string) => value === "1";

const listTmuxWindows = async (tmuxSessionName: string) => {
  const result = await runCommand([
    "tmux",
    "list-windows",
    "-t",
    tmuxSessionName,
    "-F",
    "#{window_id}\t#{window_index}\t#{window_name}\t#{?window_active,1,0}",
  ]);

  if (!result.ok) {
    return { ok: false as const, error: result.stderr || "failed to list tmux windows" };
  }

  const windows: BackgroundWindowInfo[] = [];
  for (const rawLine of trimNewline(result.stdout).split("\n")) {
    if (!rawLine) continue;
    const parts = rawLine.split("\t");
    if (parts.length < 4) continue;
    const [windowId, windowIndexText, name, activeText] = parts;
    const windowIndex = Number(windowIndexText);
    if (!windowId || !Number.isInteger(windowIndex)) continue;
    windows.push({
      windowId,
      windowIndex,
      name: name ?? "",
      active: parseTmuxBool(activeText ?? "0"),
    });
  }

  return { ok: true as const, windows };
};

const listTmuxPanes = async (tmuxSessionName: string) => {
  const result = await runCommand([
    "tmux",
    "list-panes",
    "-t",
    tmuxSessionName,
    "-F",
    "#{pane_id}\t#{window_id}\t#{window_index}\t#{pane_index}\t#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}",
  ]);

  if (!result.ok) {
    return { ok: false as const, error: result.stderr || "failed to list tmux panes" };
  }

  const panes: BackgroundPaneInfo[] = [];
  for (const rawLine of trimNewline(result.stdout).split("\n")) {
    if (!rawLine) continue;
    const parts = rawLine.split("\t");
    if (parts.length < 9) continue;
    const [paneId, windowId, windowIndexText, paneIndexText, activeText, panePidText, currentCommand, currentPath, title] =
      parts;
    const windowIndex = Number(windowIndexText);
    const paneIndex = Number(paneIndexText);
    const panePidValue = Number(panePidText);
    if (!paneId || !windowId || !Number.isInteger(windowIndex) || !Number.isInteger(paneIndex)) {
      continue;
    }
    panes.push({
      paneId,
      windowId,
      windowIndex,
      paneIndex,
      active: parseTmuxBool(activeText ?? "0"),
      panePid: Number.isFinite(panePidValue) ? panePidValue : undefined,
      currentCommand: currentCommand ?? undefined,
      currentPath: currentPath ?? undefined,
      title: title ?? undefined,
    });
  }

  return { ok: true as const, panes };
};

const ensurePaneBelongsToSession = async (tmuxSessionName: string, paneId: string) => {
  const listed = await listTmuxPanes(tmuxSessionName);
  if (!listed.ok) return listed;
  const pane = listed.panes.find((item) => item.paneId === paneId);
  if (!pane) {
    return { ok: false as const, error: "Pane not found in session" };
  }
  return { ok: true as const, pane, panes: listed.panes };
};

const ensureWindowBelongsToSession = async (tmuxSessionName: string, windowId: string) => {
  const listed = await listTmuxWindows(tmuxSessionName);
  if (!listed.ok) return listed;
  const window = listed.windows.find((item) => item.windowId === windowId);
  if (!window) {
    return { ok: false as const, error: "Window not found in session" };
  }
  return { ok: true as const, window, windows: listed.windows };
};

export const startBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  cwd: string;
  command: string;
  windowName?: string;
  paneName?: string;
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
    tool: "background",
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

  const tmuxArgs = [
    "tmux",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name}\t#{window_id}\t#{pane_id}\t#{window_index}\t#{pane_index}",
    "-s",
    metadata.tmuxSessionName,
  ];
  if (args.windowName) {
    tmuxArgs.push("-n", args.windowName);
  }
  tmuxArgs.push(`bash ${shellSingleQuote(runnerScriptFile)}`);

  const tmuxStart = await runCommand(tmuxArgs);

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

  const target = parseStartTargetOutput(tmuxStart.stdout);
  let warning: string | undefined;
  if (!target) {
    warning = "failed to parse tmux target ids";
  } else {
    metadata.primaryWindowId = target.windowId;
    metadata.primaryPaneId = target.paneId;
    if (args.paneName) {
      const paneTitleResult = await setPaneTitle(target.paneId, args.paneName);
      if (!paneTitleResult.ok) {
        warning = "paneName was ignored by tmux";
      }
    }
  }

  await writeMetadata(metadata);

  return {
    mode: "background" as const,
    sessionId: args.sessionId,
    status: "running" as const,
    cwd: args.cwd,
    command: args.command,
    startedAt,
    tmuxSessionName: metadata.tmuxSessionName,
    windowId: target?.windowId,
    paneId: target?.paneId,
    windowIndex: target?.windowIndex,
    paneIndex: target?.paneIndex,
    warning,
  };
};

export const queryBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  offset: number;
  maxItems: number;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
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
  const statusInfo = await inferBackgroundStatusFromMetadataAndLog(metadata);

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

export const listBackgroundBashSessions = async (args: {
  workspace: string;
  includeStopped?: boolean;
  limit?: number;
}) => {
  const dir = getBackgroundStateDir(args.workspace);
  if (!(await fileExists(dir))) {
    return { sessions: [] as BackgroundSessionSummary[] };
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { sessions: [] as BackgroundSessionSummary[] };
  }

  const limit = Number.isInteger(args.limit) && (args.limit as number) > 0
    ? Math.min(args.limit as number, 500)
    : 100;
  const includeStopped = args.includeStopped ?? true;

  const summaries: BackgroundSessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -5);
    const metadata = await readBackgroundSessionMetadata(args.workspace, sessionId);
    if (!metadata || "error" in metadata) continue;
    const statusInfo = await inferBackgroundStatusFromMetadataAndLog(metadata);
    if (!includeStopped && statusInfo.status !== "running") {
      continue;
    }
    summaries.push({
      sessionId: metadata.sessionId,
      status: statusInfo.status,
      cwd: metadata.cwd,
      command: metadata.command,
      startedAt: metadata.startedAt,
      updatedAt: metadata.updatedAt,
      endedAt: statusInfo.endedAt ?? metadata.endedAt,
      tmuxSessionName: metadata.tmuxSessionName,
      primaryPaneId: metadata.primaryPaneId,
      warning: statusInfo.warning,
    });
  }

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return {
    sessions: summaries.slice(0, limit),
  };
};

export const cleanupInvalidBackgroundBashSessionsOnStartup = async (args: {
  workspace: string;
}) => {
  const dir = getBackgroundStateDir(args.workspace);
  if (!(await fileExists(dir))) {
    return {
      scanned: 0,
      removed: 0,
      removedSessionIds: [] as string[],
      skipped: false,
    };
  }

  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      scanned: 0,
      removed: 0,
      removedSessionIds: [] as string[],
      skipped: true,
      reason: "tmux command is not available in runtime environment",
    };
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    return {
      scanned: 0,
      removed: 0,
      removedSessionIds: [] as string[],
      skipped: true,
      reason: error instanceof Error ? error.message : "failed to read background session directory",
    };
  }

  let scanned = 0;
  const removedSessionIds: string[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;

    const sessionId = name.slice(0, -5);
    scanned += 1;

    const metadata = await readBackgroundSessionMetadata(args.workspace, sessionId);
    if (!metadata) {
      continue;
    }

    if ("error" in metadata) {
      await removeSessionArtifacts(args.workspace, sessionId);
      removedSessionIds.push(sessionId);
      continue;
    }

    const statusInfo = await inferBackgroundStatusFromMetadataAndLog(metadata);
    if (statusInfo.status === "unknown") {
      await removeSessionArtifacts(args.workspace, sessionId);
      removedSessionIds.push(sessionId);
    }
  }

  return {
    scanned,
    removed: removedSessionIds.length,
    removedSessionIds,
    skipped: false,
  };
};

export const inspectBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  includePanePreview?: boolean;
  previewLines?: number;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
  if (!metadata) return null;
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      status: "unknown" as const,
    };
  }

  const statusInfo = await inferBackgroundStatusFromMetadataAndLog(metadata);
  const session = {
    sessionId: metadata.sessionId,
    status: statusInfo.status,
    cwd: metadata.cwd,
    command: metadata.command,
    startedAt: metadata.startedAt,
    updatedAt: metadata.updatedAt ?? metadata.startedAt,
    endedAt: statusInfo.endedAt ?? metadata.endedAt,
    exitCode: statusInfo.exitCode ?? metadata.exitCode,
    reason: statusInfo.reason ?? metadata.reason,
    tmuxSessionName: metadata.tmuxSessionName,
    primaryWindowId: metadata.primaryWindowId,
    primaryPaneId: metadata.primaryPaneId,
  };

  if (statusInfo.status !== "running") {
    return {
      session,
      windows: [] as BackgroundWindowInfo[],
      panes: [] as BackgroundPaneInfo[],
      warning: statusInfo.warning,
    };
  }

  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      session,
      windows: [] as BackgroundWindowInfo[],
      panes: [] as BackgroundPaneInfo[],
      warning: statusInfo.warning ?? "tmux command is not available in runtime environment",
    };
  }

  const windowsResult = await listTmuxWindows(metadata.tmuxSessionName);
  const panesResult = await listTmuxPanes(metadata.tmuxSessionName);
  if (!windowsResult.ok || !panesResult.ok) {
    return {
      session,
      windows: [] as BackgroundWindowInfo[],
      panes: [] as BackgroundPaneInfo[],
      warning: !windowsResult.ok ? windowsResult.error : panesResult.error,
    };
  }

  const windows = windowsResult.windows;
  const panes = panesResult.panes.map((pane) => ({ ...pane }));

  if (args.includePanePreview) {
    const previewLines = Number.isInteger(args.previewLines) && (args.previewLines as number) > 0
      ? Math.min(args.previewLines as number, 200)
      : 20;

    for (const pane of panes) {
      const capture = await runTmuxCapturePane({ paneId: pane.paneId, tailLines: previewLines });
      if (capture.ok) {
        pane.previewText = capture.text;
      }
    }
  }

  return {
    session,
    windows,
    panes,
    warning: statusInfo.warning,
  };
};

export const captureBackgroundBashPane = async (args: {
  workspace: string;
  sessionId: string;
  paneId: string;
  tailLines?: number;
  includeAnsi?: boolean;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
  if (!metadata) return null;
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      status: "unknown" as const,
    };
  }

  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      error: "tmux command is not available in runtime environment",
      sessionId: metadata.sessionId,
      paneId: args.paneId,
    };
  }

  const running = await tmuxSessionExists(metadata.tmuxSessionName);
  if (!running) {
    return {
      error: "background session is not running",
      sessionId: metadata.sessionId,
      paneId: args.paneId,
      status: "already_exited" as const,
    };
  }

  const paneCheck = await ensurePaneBelongsToSession(metadata.tmuxSessionName, args.paneId);
  if (!paneCheck.ok) {
    return {
      error: paneCheck.error,
      sessionId: metadata.sessionId,
      paneId: args.paneId,
      status: "not_found" as const,
    };
  }

  const capture = await runTmuxCapturePane({
    paneId: args.paneId,
    tailLines: args.tailLines,
    includeAnsi: args.includeAnsi,
  });

  if (!capture.ok) {
    return {
      error: capture.stderr || "failed to capture pane",
      sessionId: metadata.sessionId,
      paneId: args.paneId,
    };
  }

  return {
    sessionId: metadata.sessionId,
    paneId: args.paneId,
    capturedAt: Date.now(),
    text: capture.text,
    linesCaptured: capture.text.length === 0 ? 0 : trimNewline(capture.text).split("\n").length,
    warning: undefined as string | undefined,
  };
};

export const sendKeysToBackgroundBashPane = async (args: {
  workspace: string;
  sessionId: string;
  paneId: string;
  command: string;
  pressEnter?: boolean;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
  if (!metadata) return null;
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      success: false,
    };
  }

  const sentAt = Date.now();
  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      error: "tmux command is not available in runtime environment",
      sessionId: metadata.sessionId,
      paneId: args.paneId,
      success: false,
      sentAt,
    };
  }

  const running = await tmuxSessionExists(metadata.tmuxSessionName);
  if (!running) {
    return {
      error: "background session is not running",
      sessionId: metadata.sessionId,
      paneId: args.paneId,
      success: false,
      sentAt,
      status: "already_exited" as const,
    };
  }

  const paneCheck = await ensurePaneBelongsToSession(metadata.tmuxSessionName, args.paneId);
  if (!paneCheck.ok) {
    return {
      error: paneCheck.error,
      sessionId: metadata.sessionId,
      paneId: args.paneId,
      success: false,
      sentAt,
      status: "not_found" as const,
    };
  }

  const sendArgs = ["tmux", "send-keys", "-t", args.paneId, args.command];
  if (args.pressEnter ?? true) {
    sendArgs.push("Enter");
  }
  const result = await runCommand(sendArgs);
  if (!result.ok) {
    return {
      error: result.stderr || "failed to send keys",
      sessionId: metadata.sessionId,
      paneId: args.paneId,
      success: false,
      sentAt,
    };
  }

  return {
    success: true,
    sessionId: metadata.sessionId,
    paneId: args.paneId,
    sentCommand: args.command,
    pressEnter: args.pressEnter ?? true,
    sentAt,
  };
};

export const createBackgroundBashWindow = async (args: {
  workspace: string;
  sessionId: string;
  cwd?: string;
  command?: string;
  windowName?: string;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
  if (!metadata) return null;
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      success: false,
      status: "not_found" as const,
    };
  }

  const createdAt = Date.now();
  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      error: "tmux command is not available in runtime environment",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
    };
  }

  const running = await tmuxSessionExists(metadata.tmuxSessionName);
  if (!running) {
    return {
      error: "background session is not running",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
      status: "already_exited" as const,
    };
  }

  const cwd = args.cwd ?? metadata.cwd;
  const tmuxArgs = [
    "tmux",
    "new-window",
    "-P",
    "-F",
    "#{window_id}\t#{pane_id}\t#{window_index}\t#{pane_index}",
    "-t",
    metadata.tmuxSessionName,
    "-c",
    cwd,
  ];
  if (args.windowName) {
    tmuxArgs.push("-n", args.windowName);
  }

  const result = await runCommand(tmuxArgs);
  if (!result.ok) {
    return {
      error: result.stderr || "failed to create tmux window",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
    };
  }

  const target = parseTmuxTargetOutput(result.stdout);
  if (!target) {
    return {
      error: "failed to parse tmux window target",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
    };
  }

  let warning: string | undefined;
  if (args.command) {
    const sendResult = await sendKeysToBackgroundBashPane({
      workspace: args.workspace,
      sessionId: metadata.sessionId,
      paneId: target.paneId,
      command: args.command,
      pressEnter: true,
    });
    if (!sendResult || !sendResult.success) {
      warning = (sendResult && "error" in sendResult ? sendResult.error : "failed to execute command in new window") as string;
    }
  }

  return {
    success: true,
    sessionId: metadata.sessionId,
    windowId: target.windowId,
    paneId: target.paneId,
    windowIndex: target.windowIndex,
    paneIndex: target.paneIndex,
    cwd,
    command: args.command,
    createdAt,
    warning,
  };
};

export const splitBackgroundBashPane = async (args: {
  workspace: string;
  sessionId: string;
  targetPaneId: string;
  direction: "horizontal" | "vertical";
  cwd?: string;
  command?: string;
  size?: number;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
  if (!metadata) return null;
  if ("error" in metadata) {
    return {
      error: metadata.error,
      sessionId: args.sessionId,
      success: false,
      status: "not_found" as const,
    };
  }

  const createdAt = Date.now();
  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      error: "tmux command is not available in runtime environment",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
    };
  }

  const running = await tmuxSessionExists(metadata.tmuxSessionName);
  if (!running) {
    return {
      error: "background session is not running",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
      status: "already_exited" as const,
    };
  }

  const paneCheck = await ensurePaneBelongsToSession(metadata.tmuxSessionName, args.targetPaneId);
  if (!paneCheck.ok) {
    return {
      error: paneCheck.error,
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
      status: "not_found" as const,
    };
  }

  const cwd = args.cwd ?? metadata.cwd;
  const tmuxArgs = [
    "tmux",
    "split-window",
    args.direction === "horizontal" ? "-h" : "-v",
    "-P",
    "-F",
    "#{window_id}\t#{pane_id}\t#{window_index}\t#{pane_index}",
    "-t",
    args.targetPaneId,
    "-c",
    cwd,
  ];
  if (Number.isInteger(args.size) && (args.size as number) >= 1 && (args.size as number) <= 99) {
    tmuxArgs.push("-p", String(args.size));
  }

  const result = await runCommand(tmuxArgs);
  if (!result.ok) {
    return {
      error: result.stderr || "failed to split tmux pane",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
    };
  }

  const target = parseTmuxTargetOutput(result.stdout);
  if (!target) {
    return {
      error: "failed to parse tmux pane target",
      sessionId: metadata.sessionId,
      success: false,
      createdAt,
    };
  }

  let warning: string | undefined;
  if (args.command) {
    const sendResult = await sendKeysToBackgroundBashPane({
      workspace: args.workspace,
      sessionId: metadata.sessionId,
      paneId: target.paneId,
      command: args.command,
      pressEnter: true,
    });
    if (!sendResult || !sendResult.success) {
      warning = (sendResult && "error" in sendResult ? sendResult.error : "failed to execute command in new pane") as string;
    }
  }

  return {
    success: true,
    sessionId: metadata.sessionId,
    windowId: target.windowId,
    paneId: target.paneId,
    windowIndex: target.windowIndex,
    paneIndex: target.paneIndex,
    cwd,
    command: args.command,
    createdAt,
    warning,
  };
};

export const killBackgroundBashTarget = async (args: {
  workspace: string;
  sessionId: string;
  targetType?: "session" | "window" | "pane";
  targetId?: string;
  force?: boolean;
}) => {
  const metadata = await readBackgroundSessionMetadata(args.workspace, args.sessionId);
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
  const targetType = args.targetType ?? "session";
  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: false,
      status: "kill_failed" as const,
      targetType,
      targetId: args.targetId,
      requestedAt,
      reason: "tmux command is not available in runtime environment",
      warning: "tmux command is not available in runtime environment",
    };
  }

  const sessionRunning = await tmuxSessionExists(metadata.tmuxSessionName);
  if (targetType === "session") {
    if (!sessionRunning) {
      return {
        sessionId: metadata.sessionId,
        mode: "background" as const,
        success: true,
        status: "already_exited" as const,
        targetType,
        requestedAt,
        reason: metadata.reason ?? "background session is not running",
        warning: args.force ? "force is ignored for tmux-backed targets" : undefined,
      };
    }

    const result = await runCommand(["tmux", "kill-session", "-t", metadata.tmuxSessionName]);
    if (!result.ok) {
      return {
        sessionId: metadata.sessionId,
        mode: "background" as const,
        success: false,
        status: "kill_failed" as const,
        targetType,
        requestedAt,
        reason: result.stderr || "failed to kill tmux session",
        warning: args.force ? "force is ignored for tmux-backed targets" : undefined,
      };
    }

    const updatedMetadata: BackgroundSessionMetadata = {
      ...metadata,
      updatedAt: requestedAt,
      endedAt: requestedAt,
      statusHint: "killed",
      reason: "terminated by background tool",
    };
    await writeMetadata(updatedMetadata);

    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: true,
      status: "killed" as const,
      targetType,
      requestedAt,
      reason: "tmux kill-session",
      warning: args.force ? "force is ignored for tmux-backed targets" : undefined,
    };
  }

  if (!sessionRunning) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: true,
      status: "already_exited" as const,
      targetType,
      targetId: args.targetId,
      requestedAt,
      reason: "background session is not running",
      warning: args.force ? "force is ignored for tmux-backed targets" : undefined,
    };
  }

  if (!args.targetId) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: false,
      status: "kill_failed" as const,
      targetType,
      requestedAt,
      reason: "targetId is required for window/pane kill",
    };
  }

  if (targetType === "window") {
    const windowCheck = await ensureWindowBelongsToSession(metadata.tmuxSessionName, args.targetId);
    if (!windowCheck.ok) {
      return {
        sessionId: metadata.sessionId,
        mode: "background" as const,
        success: false,
        status: "not_found" as const,
        targetType,
        targetId: args.targetId,
        requestedAt,
        reason: windowCheck.error,
      };
    }

    const result = await runCommand(["tmux", "kill-window", "-t", args.targetId]);
    if (!result.ok) {
      return {
        sessionId: metadata.sessionId,
        mode: "background" as const,
        success: false,
        status: "kill_failed" as const,
        targetType,
        targetId: args.targetId,
        requestedAt,
        reason: result.stderr || "failed to kill tmux window",
      };
    }

    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: true,
      status: "killed" as const,
      targetType,
      targetId: args.targetId,
      requestedAt,
      reason: "tmux kill-window",
      warning: args.force ? "force is ignored for tmux-backed targets" : undefined,
    };
  }

  const paneCheck = await ensurePaneBelongsToSession(metadata.tmuxSessionName, args.targetId);
  if (!paneCheck.ok) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: false,
      status: "not_found" as const,
      targetType,
      targetId: args.targetId,
      requestedAt,
      reason: paneCheck.error,
    };
  }

  const result = await runCommand(["tmux", "kill-pane", "-t", args.targetId]);
  if (!result.ok) {
    return {
      sessionId: metadata.sessionId,
      mode: "background" as const,
      success: false,
      status: "kill_failed" as const,
      targetType,
      targetId: args.targetId,
      requestedAt,
      reason: result.stderr || "failed to kill tmux pane",
    };
  }

  return {
    sessionId: metadata.sessionId,
    mode: "background" as const,
    success: true,
    status: "killed" as const,
    targetType,
    targetId: args.targetId,
    requestedAt,
    reason: "tmux kill-pane",
    warning: args.force ? "force is ignored for tmux-backed targets" : undefined,
  };
};

export const killBackgroundBashSession = async (args: {
  workspace: string;
  sessionId: string;
  force?: boolean;
}) =>
  killBackgroundBashTarget({
    workspace: args.workspace,
    sessionId: args.sessionId,
    targetType: "session",
    force: args.force,
  });

export const captureBackgroundBashPaneText = runTmuxCapturePane;
