import { stat } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_NORMAL_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_QUERY_MAX_ITEMS = 200;
export const MAX_QUERY_MAX_ITEMS = 1_000;
export const NORMAL_SESSION_RETENTION_MS = 10 * 60_000;
export const NORMAL_SESSION_MAX_EVENTS = 2_000;

export const BASH_SESSION_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

export type BashMode = "once" | "normal" | "background";
export type BashStream = "stdout" | "stderr" | "meta";
export type BashSessionStatus =
  | "running"
  | "exited"
  | "killed"
  | "idle_timeout"
  | "failed_to_start"
  | "not_found"
  | "unknown";

export type BashOutputEvent = {
  seq: number;
  stream: BashStream;
  text: string;
  at: number;
};

type NormalCursorPayload = {
  k: "normal";
  seq: number;
};

type BackgroundCursorPayload = {
  k: "background";
  offset: number;
};

type CursorDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

let bashAvailabilityCache: boolean | null = null;
let tmuxAvailabilityCache: boolean | null = null;

const checkCommandAvailable = async (command: string, args: string[]): Promise<boolean> => {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
};

export const checkBashAvailable = async (): Promise<boolean> => {
  if (bashAvailabilityCache !== null) {
    return bashAvailabilityCache;
  }

  bashAvailabilityCache = await checkCommandAvailable("bash", ["--version"]);
  return bashAvailabilityCache;
};

export const checkTmuxAvailable = async (): Promise<boolean> => {
  if (tmuxAvailabilityCache !== null) {
    return tmuxAvailabilityCache;
  }

  tmuxAvailabilityCache = await checkCommandAvailable("tmux", ["-V"]);
  return tmuxAvailabilityCache;
};

export const resetBashToolAvailabilityCacheForTest = () => {
  bashAvailabilityCache = null;
  tmuxAvailabilityCache = null;
};

export const setBashAvailabilityCacheForTest = (value: boolean | null) => {
  bashAvailabilityCache = value;
};

export const setTmuxAvailabilityCacheForTest = (value: boolean | null) => {
  tmuxAvailabilityCache = value;
};

export const isValidBashSessionId = (sessionId: string) =>
  BASH_SESSION_ID_REGEX.test(sessionId);

export const generateBashSessionId = () => {
  const random = Math.random().toString(36).slice(2, 10);
  return `bash-${Date.now()}-${random}`;
};

export const clampQueryMaxItems = (value?: number): number => {
  if (!Number.isInteger(value)) return DEFAULT_QUERY_MAX_ITEMS;
  if ((value as number) <= 0) return DEFAULT_QUERY_MAX_ITEMS;
  return Math.min(value as number, MAX_QUERY_MAX_ITEMS);
};

const encodeCursor = (payload: NormalCursorPayload | BackgroundCursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const decodeCursor = (cursor?: string): CursorDecodeResult<Record<string, unknown> | null> => {
  if (!cursor) {
    return { ok: true, value: null };
  }

  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Invalid cursor payload" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid cursor encoding" };
  }
};

export const encodeNormalCursor = (seq: number) =>
  encodeCursor({
    k: "normal",
    seq: Number.isInteger(seq) && seq >= 0 ? seq : 0,
  });

export const decodeNormalCursor = (cursor?: string): CursorDecodeResult<number> => {
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) return decoded;
  if (!decoded.value) return { ok: true, value: 0 };

  const kind = decoded.value.k;
  const seq = decoded.value.seq;
  if (kind !== "normal" || typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return { ok: false, error: "Invalid cursor for normal session" };
  }

  return { ok: true, value: seq };
};

export const encodeBackgroundCursor = (offset: number) =>
  encodeCursor({
    k: "background",
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
  });

export const decodeBackgroundCursor = (cursor?: string): CursorDecodeResult<number> => {
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) return decoded;
  if (!decoded.value) return { ok: true, value: 0 };

  const kind = decoded.value.k;
  const offset = decoded.value.offset;
  if (
    kind !== "background" ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, error: "Invalid cursor for background session" };
  }

  return { ok: true, value: offset };
};

export const shellSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const getBashStateDir = (workspace: string) => join(workspace, ".agent", "bash");
export const getBackgroundStateDir = (workspace: string) => join(workspace, ".agent", "background");

export const toTmuxSessionName = (sessionId: string) =>
  `atom-bash-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isAbsolutePathString = (value: string) =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

export const validateExistingDirectory = async (dirpath: string) => {
  try {
    const pathStat = await stat(dirpath);
    if (!pathStat.isDirectory()) {
      return { ok: false as const, error: "cwd must be an existing directory" };
    }
    return { ok: true as const };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as any).code === "ENOENT") {
      return { ok: false as const, error: "cwd directory does not exist" };
    }
    return {
      ok: false as const,
      error: error instanceof Error ? `failed to access cwd: ${error.message}` : "failed to access cwd",
    };
  }
};
