import {
  NORMAL_SESSION_MAX_EVENTS,
  NORMAL_SESSION_RETENTION_MS,
  sleep,
  type BashOutputEvent,
  type BashSessionStatus,
} from "./bash_utils";

type NormalSessionTerminalStatus = Exclude<BashSessionStatus, "running" | "not_found" | "unknown">;

type NormalSession = {
  sessionId: string;
  mode: "normal";
  cwd: string;
  command: string;
  proc: ReturnType<typeof Bun.spawn>;
  status: "running" | NormalSessionTerminalStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  exitCode?: number;
  reason?: string;
  idleTimeoutMs: number;
  events: BashOutputEvent[];
  nextSeq: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  truncated: boolean;
};

type QueryNormalSessionArgs = {
  sessionId: string;
  afterSeq: number;
  maxItems: number;
};

type KillNormalSessionArgs = {
  sessionId: string;
  force?: boolean;
};

const sessions = new Map<string, NormalSession>();

const isTerminalStatus = (status: NormalSession["status"]) => status !== "running";

const clearIdleTimer = (session: NormalSession) => {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
};

const appendEvent = (
  session: NormalSession,
  stream: BashOutputEvent["stream"],
  text: string,
  at = Date.now(),
) => {
  const event: BashOutputEvent = {
    seq: session.nextSeq,
    stream,
    text,
    at,
  };
  session.nextSeq += 1;
  session.updatedAt = at;
  session.events.push(event);

  if (session.events.length > NORMAL_SESSION_MAX_EVENTS) {
    const overflow = session.events.length - NORMAL_SESSION_MAX_EVENTS;
    session.events.splice(0, overflow);
    session.truncated = true;
  }
};

const scheduleIdleTimeout = (session: NormalSession) => {
  clearIdleTimer(session);
  if (session.status !== "running") return;

  session.idleTimer = setTimeout(async () => {
    const current = sessions.get(session.sessionId);
    if (!current || current.status !== "running") {
      return;
    }

    current.status = "idle_timeout";
    current.reason = "idle timeout";
    appendEvent(current, "meta", "idle-timeout");

    try {
      current.proc.kill("SIGTERM");
      await Promise.race([current.proc.exited, sleep(1_000)]);
      if (current.endedAt === undefined) {
        current.proc.kill("SIGKILL");
      }
    } catch {
      // Best-effort termination. Final state is resolved in exited handler.
    }
  }, session.idleTimeoutMs);
};

const consumePipeLines = async (
  sessionId: string,
  stream: "stdout" | "stderr",
  readable: ReadableStream<Uint8Array> | null,
) => {
  if (!readable) return;

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;

        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const session = sessions.get(sessionId);
        if (!session) {
          continue;
        }
        appendEvent(session, stream, line);
        scheduleIdleTimeout(session);
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const session = sessions.get(sessionId);
      if (session) {
        appendEvent(session, stream, buffer);
        scheduleIdleTimeout(session);
      }
    }
  } catch {
    const session = sessions.get(sessionId);
    if (session) {
      appendEvent(session, "meta", `${stream}-read-error`);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
};

const finalizeSessionExit = (sessionId: string, exitCode: number) => {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearIdleTimer(session);
  session.exitCode = exitCode;
  session.endedAt = Date.now();
  session.updatedAt = session.endedAt;

  if (session.status === "running") {
    session.status = "exited";
    session.reason = "process exited";
  }

  appendEvent(session, "meta", `exit:${exitCode}`, session.endedAt);
};

const pruneExpiredSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (!isTerminalStatus(session.status)) continue;
    if (!session.endedAt) continue;
    if (now - session.endedAt <= NORMAL_SESSION_RETENTION_MS) continue;

    clearIdleTimer(session);
    sessions.delete(sessionId);
  }
};

const waitForExitOrTimeout = async (
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<"exited" | "timeout"> => {
  const result = await Promise.race([
    proc.exited.then(() => "exited" as const),
    sleep(timeoutMs).then(() => "timeout" as const),
  ]);
  return result;
};

export const hasNormalBashSession = (sessionId: string) => {
  pruneExpiredSessions();
  return sessions.has(sessionId);
};

export const getNormalBashSessionCwd = (sessionId: string): string | undefined => {
  pruneExpiredSessions();
  return sessions.get(sessionId)?.cwd;
};

export const startNormalBashSession = async (args: {
  sessionId: string;
  cwd: string;
  command: string;
  idleTimeoutMs: number;
}) => {
  pruneExpiredSessions();
  if (sessions.has(args.sessionId)) {
    return {
      error: "Session already exists",
      sessionId: args.sessionId,
      status: "failed_to_start" as const,
    };
  }

  try {
    const proc = Bun.spawn(["bash", "-lc", args.command], {
      cwd: args.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const now = Date.now();
    const session: NormalSession = {
      sessionId: args.sessionId,
      mode: "normal",
      cwd: args.cwd,
      command: args.command,
      proc,
      status: "running",
      startedAt: now,
      updatedAt: now,
      idleTimeoutMs: args.idleTimeoutMs,
      events: [],
      nextSeq: 1,
      truncated: false,
    };

    sessions.set(args.sessionId, session);
    appendEvent(session, "meta", "start", now);
    scheduleIdleTimeout(session);

    void consumePipeLines(args.sessionId, "stdout", proc.stdout);
    void consumePipeLines(args.sessionId, "stderr", proc.stderr);
    void proc.exited.then((exitCode) => {
      finalizeSessionExit(args.sessionId, exitCode);
    });

    return {
      mode: "normal" as const,
      sessionId: args.sessionId,
      status: "running" as const,
      cwd: args.cwd,
      command: args.command,
      startedAt: now,
      idleTimeoutMs: args.idleTimeoutMs,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "failed to start bash process",
      sessionId: args.sessionId,
      status: "failed_to_start" as const,
    };
  }
};

export const queryNormalBashSession = ({ sessionId, afterSeq, maxItems }: QueryNormalSessionArgs) => {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;

  const firstSeq = session.events[0]?.seq;
  const truncated =
    session.truncated &&
    firstSeq !== undefined &&
    Number.isInteger(afterSeq) &&
    afterSeq < firstSeq - 1;

  const allNewItems = session.events.filter((item) => item.seq > afterSeq);
  const items = allNewItems.slice(0, maxItems);

  const nextSeq =
    items.length > 0
      ? items[items.length - 1]!.seq
      : truncated && firstSeq !== undefined
        ? firstSeq - 1
        : afterSeq;

  return {
    sessionId: session.sessionId,
    mode: session.mode,
    cwd: session.cwd,
    command: session.command,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    reason: session.reason,
    items,
    nextSeq,
    done: session.status !== "running",
    truncated,
  };
};

export const killNormalBashSession = async ({ sessionId, force = false }: KillNormalSessionArgs) => {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;

  const requestedAt = Date.now();

  if (session.status !== "running") {
    return {
      sessionId,
      mode: "normal" as const,
      cwd: session.cwd,
      success: true,
      status: "already_exited" as const,
      requestedAt,
      reason: session.reason ?? "already exited",
    };
  }

  appendEvent(session, "meta", force ? "kill-force-requested" : "kill-requested", requestedAt);

  try {
    if (force) {
      session.proc.kill("SIGKILL");
    } else {
      session.proc.kill("SIGTERM");
      const waitResult = await waitForExitOrTimeout(session.proc, 2_000);
      if (waitResult === "timeout" && session.endedAt === undefined) {
        session.proc.kill("SIGKILL");
      }
    }

    session.status = "killed";
    session.reason = "terminated by bash tool";
    session.updatedAt = requestedAt;

    await Promise.race([session.proc.exited, sleep(2_500)]);
    appendEvent(session, "meta", "killed", Date.now());

    return {
      sessionId,
      mode: "normal" as const,
      cwd: session.cwd,
      success: true,
      status: "killed" as const,
      requestedAt,
      reason: force ? "SIGKILL" : "SIGTERM/SIGKILL",
    };
  } catch (error) {
    return {
      sessionId,
      mode: "normal" as const,
      cwd: session.cwd,
      success: false,
      status: "kill_failed" as const,
      requestedAt,
      reason: error instanceof Error ? error.message : "failed to terminate process",
    };
  }
};

export const resetNormalBashSessionsForTest = async () => {
  for (const session of sessions.values()) {
    clearIdleTimer(session);
    if (session.status === "running") {
      try {
        session.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        await Promise.race([session.proc.exited, sleep(500)]);
      } catch {
        // ignore
      }
    }
  }
  sessions.clear();
};
