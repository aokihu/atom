import type { ToolDisplayEnvelope } from "../../../types/http";

const DISPLAY_VERSION = 1 as const;
const MAX_PREVIEW_TEXT_CHARS = 1_200;
const MAX_PREVIEW_LINES = 6;
const MAX_PREVIEW_LINE_CHARS = 160;
const MAX_PREVIEW_ARRAY_ITEMS = 20;

type DisplayField = {
  label: string;
  value: string;
};

type DisplayPreview = {
  title?: string;
  lines: string[];
  truncated?: boolean;
};

type DisplayData = {
  [key: string]: unknown;
  summary?: string;
  fields?: DisplayField[];
  previews?: DisplayPreview[];
};

type StringPreviewStats = {
  bytes: number;
  lineCount: number;
  preview: DisplayPreview | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const getString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const getBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

const getNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const getStringArray = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key];
  return isStringArray(value) ? value : undefined;
};

const toYesNo = (value: boolean | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return value ? "yes" : "no";
};

const formatTimestamp = (value: number | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
};

const clipLine = (line: string, maxChars = MAX_PREVIEW_LINE_CHARS): string => {
  if (maxChars <= 0) return "";
  if (line.length <= maxChars) return line;
  if (maxChars <= 3) return line.slice(0, maxChars);
  return `${line.slice(0, maxChars - 3)}...`;
};

const trimTrailingEmptyLines = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end -= 1;
  }
  return lines.slice(0, end);
};

const buildPreviewFromLines = (title: string | undefined, lines: string[]): DisplayPreview | undefined => {
  if (lines.length === 0) return undefined;
  const clippedLines = lines.slice(0, MAX_PREVIEW_LINES).map((line) => clipLine(line));
  return {
    ...(title ? { title } : {}),
    lines: clippedLines,
    truncated: lines.length > MAX_PREVIEW_LINES,
  };
};

const buildStringPreviewStats = (text: string, title?: string): StringPreviewStats => {
  const normalized = text.replace(/\r\n/g, "\n");
  const bytes = Buffer.byteLength(text);
  const fullLines = normalized.length === 0 ? [] : normalized.split("\n");
  const lineCount = trimTrailingEmptyLines(fullLines).length;

  const charLimited =
    normalized.length > MAX_PREVIEW_TEXT_CHARS
      ? normalized.slice(0, MAX_PREVIEW_TEXT_CHARS)
      : normalized;
  const previewLines = trimTrailingEmptyLines(charLimited.length === 0 ? [] : charLimited.split("\n"));
  const preview = buildPreviewFromLines(title, previewLines);

  if (preview && normalized.length > MAX_PREVIEW_TEXT_CHARS) {
    preview.truncated = true;
  }

  return {
    bytes,
    lineCount,
    preview,
  };
};

const createField = (label: string, value: string | number | boolean | undefined): DisplayField | undefined => {
  if (value === undefined) return undefined;
  return {
    label,
    value: typeof value === "string" ? value : String(value),
  };
};

const compactFields = (fields: Array<DisplayField | undefined>): DisplayField[] | undefined => {
  const filtered = fields.filter((field): field is DisplayField => field !== undefined);
  return filtered.length > 0 ? filtered : undefined;
};

const compactPreviews = (previews: Array<DisplayPreview | undefined>): DisplayPreview[] | undefined => {
  const filtered = previews.filter((preview): preview is DisplayPreview => preview !== undefined);
  return filtered.length > 0 ? filtered : undefined;
};

const makeEnvelope = (
  toolName: string,
  phase: "call" | "result",
  templateKey: string,
  data: DisplayData,
): ToolDisplayEnvelope => ({
  version: DISPLAY_VERSION,
  toolName,
  phase,
  templateKey,
  data: data as Record<string, unknown>,
});

const buildGenericErrorResult = (
  toolName: string,
  templateKey: string,
  errorMessage: string,
  contextFields?: Array<DisplayField | undefined>,
): ToolDisplayEnvelope =>
  makeEnvelope(toolName, "result", templateKey, {
    summary: `Failed: ${errorMessage}`,
    fields: compactFields([createField("error", errorMessage), ...(contextFields ?? [])]),
  });

const buildReadCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.read.call", {
    summary: "Reading file",
    fields: compactFields([createField("filepath", getString(input, "filepath"))]),
  });

const buildReadResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.read.result", errorMessage, [
      createField("filepath", input ? getString(input, "filepath") : undefined),
    ]);
  }

  const content = result.content;
  const sizeBytes = getNumber(result, "size");
  const filepath = input ? getString(input, "filepath") : undefined;
  const previewLines: string[] = [];
  let lineCount: number | undefined;

  if (Array.isArray(content)) {
    lineCount = content.length;
    for (const rawLine of content.slice(0, MAX_PREVIEW_LINES)) {
      if (!Array.isArray(rawLine)) continue;
      const lineNo = rawLine[0];
      const lineText = rawLine[1];
      if (typeof lineNo !== "number" || !Number.isFinite(lineNo)) continue;
      if (typeof lineText !== "string") continue;
      previewLines.push(`${lineNo}: ${clipLine(lineText, Math.max(20, MAX_PREVIEW_LINE_CHARS - 12))}`);
    }
  }

  return makeEnvelope(toolName, "result", "builtin.read.result", {
    summary: filepath ? `Read file ${filepath}` : "Read file",
    fields: compactFields([
      createField("filepath", filepath),
      createField("sizeBytes", sizeBytes),
      createField("lineCount", lineCount),
    ]),
    previews: compactPreviews([
      previewLines.length > 0
        ? {
            title: "Preview",
            lines: previewLines,
            truncated: lineCount !== undefined && lineCount > previewLines.length,
          }
        : undefined,
    ]),
  });
};

const countLines = (text: string): number => trimTrailingEmptyLines(text.replace(/\r\n/g, "\n").split("\n")).length;

const buildWriteCallDisplay = (toolName: string, input: Record<string, unknown>) => {
  const content = getString(input, "content") ?? "";
  return makeEnvelope(toolName, "call", "builtin.write.call", {
    summary: "Writing file",
    fields: compactFields([
      createField("filepath", getString(input, "filepath")),
      createField("append", toYesNo(getBoolean(input, "append"))),
      createField("contentBytes", Buffer.byteLength(content)),
      createField("contentLineCount", countLines(content)),
    ]),
  });
};

const buildWriteResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.write.result", errorMessage, [
      createField("filepath", input ? getString(input, "filepath") : undefined),
    ]);
  }

  return makeEnvelope(toolName, "result", "builtin.write.result", {
    summary: "Write completed",
    fields: compactFields([
      createField("filepath", getString(result, "filepath") ?? (input ? getString(input, "filepath") : undefined)),
      createField("append", toYesNo(getBoolean(result, "append") ?? (input ? getBoolean(input, "append") : undefined))),
      createField("bytesWritten", getNumber(result, "bytes")),
    ]),
  });
};

const buildLsCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.ls.call", {
    summary: "Listing directory",
    fields: compactFields([
      createField("dirpath", getString(input, "dirpath")),
      createField("all", toYesNo(getBoolean(input, "all"))),
      createField("long", toYesNo(getBoolean(input, "long"))),
    ]),
  });

const buildLsResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  const dirpath = getString(result, "dirpath") ?? (input ? getString(input, "dirpath") : undefined);
  const command = getString(result, "command");

  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.ls.result", errorMessage, [
      createField("dirpath", dirpath),
      createField("command", command),
    ]);
  }

  const output = getString(result, "output") ?? "";
  const rawLines = trimTrailingEmptyLines(output.replace(/\r\n/g, "\n").split("\n"));
  const inputLong = input ? getBoolean(input, "long") : undefined;
  const entryLines =
    rawLines.length > 0 && (inputLong ?? false) && rawLines[0]?.startsWith("total ") ? rawLines.slice(1) : rawLines;

  return makeEnvelope(toolName, "result", "builtin.ls.result", {
    summary: dirpath ? `Listed ${dirpath}` : "Listed directory",
    fields: compactFields([
      createField("dirpath", dirpath),
      createField("command", command),
      createField("entryCount", entryLines.length),
    ]),
    previews: compactPreviews([buildStringPreviewStats(output, "Preview").preview]),
  });
};

const buildTreeCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.tree.call", {
    summary: "Reading directory tree",
    fields: compactFields([
      createField("dirpath", getString(input, "dirpath")),
      createField("level", getNumber(input, "level")),
      createField("all", toYesNo(getBoolean(input, "all"))),
    ]),
  });

const parseTreeCounts = (output: string) => {
  const lines = trimTrailingEmptyLines(output.replace(/\r\n/g, "\n").split("\n"));
  const last = lines[lines.length - 1];
  if (!last) {
    return { directories: undefined, files: undefined };
  }
  const match = /(\d+)\s+directories?,\s+(\d+)\s+files?/.exec(last);
  if (!match) {
    return { directories: undefined, files: undefined };
  }
  return {
    directories: Number(match[1]),
    files: Number(match[2]),
  };
};

const buildTreeResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  const dirpath = getString(result, "dirpath") ?? (input ? getString(input, "dirpath") : undefined);
  const command = getString(result, "command");
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.tree.result", errorMessage, [
      createField("dirpath", dirpath),
      createField("command", command),
    ]);
  }

  const output = getString(result, "output") ?? "";
  const counts = parseTreeCounts(output);

  return makeEnvelope(toolName, "result", "builtin.tree.result", {
    summary: dirpath ? `Tree for ${dirpath}` : "Directory tree",
    fields: compactFields([
      createField("dirpath", dirpath),
      createField("command", command),
      createField("directories", counts.directories),
      createField("files", counts.files),
    ]),
    previews: compactPreviews([buildStringPreviewStats(output, "Preview").preview]),
  });
};

const buildRipgrepCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.ripgrep.call", {
    summary: "Searching with ripgrep",
    fields: compactFields([
      createField("dirpath", getString(input, "dirpath")),
      createField("pattern", getString(input, "pattern")),
      createField("caseSensitive", toYesNo(getBoolean(input, "caseSensitive"))),
      createField("fileGlob", getString(input, "fileGlob")),
    ]),
  });

const parseRipgrepFiles = (lines: string[]): number => {
  const files = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    const match = /^(.+?):\d+:/.exec(line);
    if (match?.[1]) {
      files.add(match[1]);
      continue;
    }
    const firstColon = line.indexOf(":");
    if (firstColon > 0) {
      files.add(line.slice(0, firstColon));
    }
  }
  return files.size;
};

const buildRipgrepResultDisplay = (
  toolName: string,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  const command = getString(result, "command");
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.ripgrep.result", errorMessage, [
      createField("command", command),
      createField("dirpath", getString(result, "dirpath")),
    ]);
  }

  const output = getString(result, "output") ?? "";
  const lines = trimTrailingEmptyLines(output.replace(/\r\n/g, "\n").split("\n"));
  const matchCount = lines.length;

  return makeEnvelope(toolName, "result", "builtin.ripgrep.result", {
    summary: matchCount > 0 ? `Found ${matchCount} matches` : "No matches",
    fields: compactFields([
      createField("dirpath", getString(result, "dirpath")),
      createField("pattern", getString(result, "pattern")),
      createField("command", command),
      createField("matchCount", matchCount),
      createField("fileCountApprox", parseRipgrepFiles(lines)),
    ]),
    previews: compactPreviews([buildStringPreviewStats(output, "Matches").preview]),
  });
};

const buildCpCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.cp.call", {
    summary: "Copying path",
    fields: compactFields([
      createField("source", getString(input, "source")),
      createField("destination", getString(input, "destination")),
      createField("recursive", toYesNo(getBoolean(input, "recursive"))),
      createField("overwrite", toYesNo(getBoolean(input, "overwrite"))),
    ]),
  });

const buildCpResultDisplay = (toolName: string, result: Record<string, unknown>, errorMessage?: string) => {
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.cp.result", errorMessage, [
      createField("source", getString(result, "source")),
      createField("destination", getString(result, "destination")),
    ]);
  }

  return makeEnvelope(toolName, "result", "builtin.cp.result", {
    summary: "Copy completed",
    fields: compactFields([
      createField("source", getString(result, "source")),
      createField("destination", getString(result, "destination")),
      createField("recursive", toYesNo(getBoolean(result, "recursive"))),
      createField("overwrite", toYesNo(getBoolean(result, "overwrite"))),
      createField("method", getString(result, "method")),
    ]),
  });
};

const buildMvCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.mv.call", {
    summary: "Moving path",
    fields: compactFields([
      createField("source", getString(input, "source")),
      createField("destination", getString(input, "destination")),
      createField("overwrite", toYesNo(getBoolean(input, "overwrite"))),
    ]),
  });

const buildMvResultDisplay = (toolName: string, result: Record<string, unknown>, errorMessage?: string) => {
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.mv.result", errorMessage, [
      createField("source", getString(result, "source")),
      createField("destination", getString(result, "destination")),
    ]);
  }

  return makeEnvelope(toolName, "result", "builtin.mv.result", {
    summary: "Move completed",
    fields: compactFields([
      createField("source", getString(result, "source")),
      createField("destination", getString(result, "destination")),
      createField("overwrite", toYesNo(getBoolean(result, "overwrite"))),
      createField("method", getString(result, "method")),
    ]),
  });
};

const buildGitCallDisplay = (toolName: string, input: Record<string, unknown>) => {
  const args = getStringArray(input, "args") ?? [];
  const subcommand = getString(input, "subcommand");
  const command = subcommand ? ["git", subcommand, ...args].join(" ") : undefined;

  return makeEnvelope(toolName, "call", "builtin.git.call", {
    summary: "Running git command",
    fields: compactFields([
      createField("cwd", getString(input, "cwd")),
      createField("subcommand", subcommand),
      createField("args", args.length > 0 ? args.join(" ") : undefined),
      createField("command", command),
    ]),
  });
};

const buildGitResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  const stdout = getString(result, "stdout") ?? "";
  const stderr = getString(result, "stderr") ?? "";
  const stdoutStats = buildStringPreviewStats(stdout, "stdout");
  const stderrStats = buildStringPreviewStats(stderr, "stderr");

  return makeEnvelope(toolName, "result", "builtin.git.result", {
    summary: errorMessage ? `Git command failed` : "Git command completed",
    fields: compactFields([
      createField("error", errorMessage),
      createField("cwd", getString(result, "cwd") ?? (input ? getString(input, "cwd") : undefined)),
      createField("command", getString(result, "command")),
      createField("exitCode", getNumber(result, "exitCode")),
      createField("stdoutLines", stdoutStats.lineCount),
      createField("stderrLines", stderrStats.lineCount),
    ]),
    previews: compactPreviews([stdoutStats.preview, stderrStats.preview]),
  });
};

const buildBashCallDisplay = (toolName: string, input: Record<string, unknown>) => {
  const action = getString(input, "action");
  const templateKey = action === "start"
    ? "builtin.bash.start.call"
    : action === "query"
      ? "builtin.bash.query.call"
      : action === "kill"
        ? "builtin.bash.kill.call"
        : "builtin.bash.call";

  return makeEnvelope(toolName, "call", templateKey, {
    summary: action ? `bash ${action}` : "bash",
    fields: compactFields([
      createField("action", action),
      createField("mode", getString(input, "mode")),
      createField("cwd", getString(input, "cwd")),
      createField("command", getString(input, "command")),
      createField("sessionId", getString(input, "sessionId")),
      createField("cursor", getString(input, "cursor")),
      createField("maxItems", getNumber(input, "maxItems")),
      createField("idleTimeoutMs", getNumber(input, "idleTimeoutMs")),
      createField("force", toYesNo(getBoolean(input, "force"))),
    ]),
  });
};

const buildBashEventPreview = (items: unknown): DisplayPreview | undefined => {
  if (!Array.isArray(items)) return undefined;

  const lines: string[] = [];
  const limit = Math.min(items.length, MAX_PREVIEW_ARRAY_ITEMS);
  for (let index = 0; index < limit; index += 1) {
    const item = items[index];
    if (!isRecord(item)) continue;
    const seq = getNumber(item, "seq");
    const stream = getString(item, "stream");
    const text = getString(item, "text");
    if (stream === undefined || text === undefined) continue;
    const seqLabel = seq !== undefined ? `#${seq}` : "#?";
    lines.push(`${seqLabel} ${stream}: ${clipLine(text, Math.max(20, MAX_PREVIEW_LINE_CHARS - 18))}`);
  }

  if (lines.length === 0) return undefined;
  return {
    title: "events",
    lines: lines.slice(0, MAX_PREVIEW_LINES),
    truncated: items.length > MAX_PREVIEW_LINES,
  };
};

const buildBashOnceResultDisplay = (toolName: string, result: Record<string, unknown>, errorMessage?: string) => {
  const stdout = getString(result, "stdout") ?? "";
  const stderr = getString(result, "stderr") ?? "";
  const stdoutStats = buildStringPreviewStats(stdout, "stdout");
  const stderrStats = buildStringPreviewStats(stderr, "stderr");
  const exitCode = getNumber(result, "exitCode");
  const success = getBoolean(result, "success");

  return makeEnvelope(toolName, "result", "builtin.bash.once.result", {
    summary:
      success === false || errorMessage
        ? `bash once failed${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`
        : `bash once completed${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`,
    fields: compactFields([
      createField("error", errorMessage),
      createField("mode", getString(result, "mode")),
      createField("cwd", getString(result, "cwd")),
      createField("command", getString(result, "command")),
      createField("success", toYesNo(success)),
      createField("exitCode", exitCode),
      createField("durationMs", getNumber(result, "durationMs")),
    ]),
    previews: compactPreviews([stdoutStats.preview, stderrStats.preview]),
  });
};

const buildBashSessionStartResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) =>
  makeEnvelope(toolName, "result", "builtin.bash.session_start.result", {
    summary: errorMessage ? "Bash session failed to start" : "Bash session started",
    fields: compactFields([
      createField("error", errorMessage),
      createField("mode", getString(result, "mode") ?? (input ? getString(input, "mode") : undefined)),
      createField("sessionId", getString(result, "sessionId") ?? (input ? getString(input, "sessionId") : undefined)),
      createField("status", getString(result, "status")),
      createField("cwd", getString(result, "cwd") ?? (input ? getString(input, "cwd") : undefined)),
      createField("command", getString(result, "command") ?? (input ? getString(input, "command") : undefined)),
      createField("idleTimeoutMs", getNumber(result, "idleTimeoutMs") ?? (input ? getNumber(input, "idleTimeoutMs") : undefined)),
      createField("startedAt", formatTimestamp(getNumber(result, "startedAt"))),
    ]),
  });

const buildBashSessionQueryResultDisplay = (
  toolName: string,
  result: Record<string, unknown>,
  errorMessage?: string,
) =>
  makeEnvelope(toolName, "result", "builtin.bash.session_query.result", {
    summary: errorMessage ? "Bash session query failed" : "Bash session events",
    fields: compactFields([
      createField("error", errorMessage),
      createField("mode", getString(result, "mode")),
      createField("sessionId", getString(result, "sessionId")),
      createField("status", getString(result, "status")),
      createField("cwd", getString(result, "cwd")),
      createField("command", getString(result, "command")),
      createField("done", toYesNo(getBoolean(result, "done"))),
      createField("truncated", toYesNo(getBoolean(result, "truncated"))),
      createField("itemCount", Array.isArray(result.items) ? result.items.length : undefined),
      createField("nextCursor", getString(result, "nextCursor")),
      createField("reason", getString(result, "reason")),
      createField("warning", getString(result, "warning")),
      createField("exitCode", getNumber(result, "exitCode")),
    ]),
    previews: compactPreviews([buildBashEventPreview(result.items)]),
  });

const buildBashSessionKillResultDisplay = (
  toolName: string,
  result: Record<string, unknown>,
  errorMessage?: string,
) =>
  makeEnvelope(toolName, "result", "builtin.bash.session_kill.result", {
    summary: errorMessage ? "Bash session kill failed" : "Bash session kill result",
    fields: compactFields([
      createField("error", errorMessage),
      createField("mode", getString(result, "mode")),
      createField("sessionId", getString(result, "sessionId")),
      createField("status", getString(result, "status")),
      createField("success", toYesNo(getBoolean(result, "success"))),
      createField("cwd", getString(result, "cwd")),
      createField("requestedAt", formatTimestamp(getNumber(result, "requestedAt"))),
      createField("reason", getString(result, "reason")),
      createField("warning", getString(result, "warning")),
    ]),
  });

const buildBashErrorResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) =>
  makeEnvelope(toolName, "result", "builtin.bash.error.result", {
    summary: "Bash command error",
    fields: compactFields([
      createField("error", errorMessage ?? getString(result, "error")),
      createField("action", input ? getString(input, "action") : undefined),
      createField("mode", getString(result, "mode") ?? (input ? getString(input, "mode") : undefined)),
      createField("sessionId", getString(result, "sessionId") ?? (input ? getString(input, "sessionId") : undefined)),
      createField("cwd", getString(result, "cwd") ?? (input ? getString(input, "cwd") : undefined)),
      createField("command", getString(result, "command") ?? (input ? getString(input, "command") : undefined)),
      createField("status", getString(result, "status")),
      createField("ruleId", getString(result, "ruleId")),
      createField("detail", getString(result, "detail")),
      createField("hint", getString(result, "hint")),
      createField("warning", getString(result, "warning")),
    ]),
  });

const buildBashResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  const mode = getString(result, "mode");
  const action = input ? getString(input, "action") : undefined;

  if (mode === "once") {
    return buildBashOnceResultDisplay(toolName, result, errorMessage);
  }

  if (action === "query" || Array.isArray(result.items) || "nextCursor" in result) {
    return buildBashSessionQueryResultDisplay(toolName, result, errorMessage);
  }

  if (action === "kill" || "requestedAt" in result) {
    return buildBashSessionKillResultDisplay(toolName, result, errorMessage);
  }

  if (action === "start" || "startedAt" in result || mode === "normal" || mode === "background") {
    return buildBashSessionStartResultDisplay(toolName, input, result, errorMessage);
  }

  return buildBashErrorResultDisplay(toolName, input, result, errorMessage);
};

const buildWebfetchCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", "builtin.webfetch.call", {
    summary: "Fetching URL",
    fields: compactFields([createField("url", getString(input, "url"))]),
  });

const buildWebfetchResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: unknown,
  errorMessage?: string,
) => {
  if (errorMessage) {
    return buildGenericErrorResult(toolName, "builtin.webfetch.result", errorMessage, [
      createField("url", input ? getString(input, "url") : undefined),
    ]);
  }

  if (typeof result !== "string") {
    return undefined;
  }

  const stats = buildStringPreviewStats(result, "Preview");
  return makeEnvelope(toolName, "result", "builtin.webfetch.result", {
    summary: "Fetched URL",
    fields: compactFields([
      createField("url", input ? getString(input, "url") : undefined),
      createField("bytes", stats.bytes),
      createField("lineCount", stats.lineCount),
    ]),
    previews: compactPreviews([stats.preview]),
  });
};

const isTodoStatus = (value: unknown): value is "open" | "done" =>
  value === "open" || value === "done";

const formatTodoMark = (status: unknown) => (status === "done" ? "✓" : "☐");

const buildTodoItemPreviewLines = (items: unknown): string[] => {
  if (!Array.isArray(items)) return [];

  const lines: string[] = [];
  for (const item of items.slice(0, MAX_PREVIEW_ARRAY_ITEMS)) {
    if (!isRecord(item)) continue;
    const id = getNumber(item, "id");
    const title = getString(item, "title");
    const status = getString(item, "status");
    if (title === undefined || !isTodoStatus(status)) continue;
    const prefix = formatTodoMark(status);
    const idPrefix = id !== undefined ? `#${id} ` : "";
    lines.push(`${prefix} ${idPrefix}${clipLine(title, 120)}`);
  }
  return lines;
};

const buildTodoItemsData = (args: {
  items: unknown;
  fallbackItem?: Record<string, unknown>;
}): Array<Record<string, unknown>> => {
  const normalized: Array<Record<string, unknown>> = [];

  const appendItem = (raw: unknown) => {
    if (!isRecord(raw)) return;
    const id = getNumber(raw, "id");
    const title = getString(raw, "title");
    const status = getString(raw, "status");
    if (title === undefined || !isTodoStatus(status)) return;
    normalized.push({
      ...(id !== undefined ? { id } : {}),
      title,
      status,
      mark: formatTodoMark(status),
    });
  };

  if (Array.isArray(args.items)) {
    for (const item of args.items.slice(0, MAX_PREVIEW_ARRAY_ITEMS)) {
      appendItem(item);
    }
  } else if (args.fallbackItem) {
    appendItem(args.fallbackItem);
  }

  return normalized;
};

const buildTodoCallDisplay = (toolName: string, input: Record<string, unknown>) =>
  makeEnvelope(toolName, "call", `builtin.${toolName}.call`, {
    todo_id: "workspace",
    summary: `TODO ${toolName.replace(/^todo_/, "")}`,
    fields: compactFields([
      createField("id", getNumber(input, "id")),
      createField("status", getString(input, "status")),
      createField("limit", getNumber(input, "limit")),
      createField("title", getString(input, "title")),
    ]),
  });

const buildTodoResultDisplay = (
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
  errorMessage?: string,
) => {
  if (errorMessage) {
    return buildGenericErrorResult(toolName, `builtin.${toolName}.result`, errorMessage, [
      createField("id", getNumber(result, "id") ?? (input ? getNumber(input, "id") : undefined)),
    ]);
  }

  const item = isRecord(result.item) ? result.item : undefined;
  const todoMeta = isRecord(result.todo) ? result.todo : undefined;
  const itemStatus = item ? getString(item, "status") : undefined;
  const itemTitle = item ? getString(item, "title") : undefined;
  const itemId = item ? getNumber(item, "id") : undefined;
  const listPreviewLines = buildTodoItemPreviewLines(result.items);
  const todoSummary = todoMeta ? getString(todoMeta, "summary") : undefined;
  const todoTotal = todoMeta ? getNumber(todoMeta, "total") : undefined;
  const todoStep = todoMeta ? getNumber(todoMeta, "step") : undefined;
  const itemPreviewLine =
    itemTitle && isTodoStatus(itemStatus)
      ? `${formatTodoMark(itemStatus)} ${itemId !== undefined ? `#${itemId} ` : ""}${clipLine(itemTitle, 120)}`
      : undefined;
  const todoItemsData = buildTodoItemsData({
    items: result.items,
    fallbackItem: item,
  });
  const progressPreviewLines = [
    todoSummary,
    todoTotal !== undefined || todoStep !== undefined
      ? `Step ${todoStep ?? "-"} / ${todoTotal ?? "-"}`
      : undefined,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);
  const itemPreviewBlock = listPreviewLines.length > 0
    ? {
        title: "TODO Items",
        lines: listPreviewLines,
        truncated: Array.isArray(result.items) && result.items.length > listPreviewLines.length,
      }
    : itemPreviewLine
      ? {
          title: "TODO Item",
          lines: [itemPreviewLine],
        }
      : undefined;

  let summary = "TODO operation completed";
  if (toolName === "todo_list") {
    const count = Array.isArray(result.items) ? result.items.length : getNumber(result, "count");
    summary = `TODO list (${typeof count === "number" ? count : 0} items)`;
  }

  if (todoSummary) {
    summary = todoSummary;
  } else if (itemPreviewLine) {
    summary = itemPreviewLine;
  } else if (toolName === "todo_clear_done") {
    summary = "Cleared completed TODO items";
  } else if (toolName === "todo_remove") {
    summary = "Removed TODO item";
  }

  return makeEnvelope(toolName, "result", `builtin.${toolName}.result`, {
    todo_id: "workspace",
    summary,
    progress: todoSummary || todoTotal !== undefined || todoStep !== undefined
      ? {
          ...(todoSummary ? { summary: todoSummary } : {}),
          ...(todoTotal !== undefined ? { total: todoTotal } : {}),
          ...(todoStep !== undefined ? { step: todoStep } : {}),
        }
      : undefined,
    items: todoItemsData,
    fields: compactFields([
      createField("success", toYesNo(getBoolean(result, "success"))),
      createField("count", getNumber(result, "count")),
      createField("deletedCount", getNumber(result, "deletedCount")),
      createField("id", getNumber(result, "id") ?? itemId),
      createField("status", getString(result, "status") ?? (input ? getString(input, "status") : undefined) ?? itemStatus),
      createField("limit", getNumber(result, "limit") ?? (input ? getNumber(input, "limit") : undefined)),
      createField("total", todoTotal ?? getNumber(result, "total")),
      createField("step", todoStep ?? getNumber(result, "step")),
    ]),
    previews: compactPreviews([
      progressPreviewLines.length > 0
        ? {
            title: "TODO Progress",
            lines: progressPreviewLines,
          }
        : undefined,
      itemPreviewBlock,
    ]),
  });
};

export const buildToolCallDisplay = (
  toolName: string,
  input: unknown,
): ToolDisplayEnvelope | undefined => {
  if (!isRecord(input)) return undefined;

  switch (toolName) {
    case "read":
      return buildReadCallDisplay(toolName, input);
    case "write":
      return buildWriteCallDisplay(toolName, input);
    case "ls":
      return buildLsCallDisplay(toolName, input);
    case "tree":
      return buildTreeCallDisplay(toolName, input);
    case "ripgrep":
      return buildRipgrepCallDisplay(toolName, input);
    case "cp":
      return buildCpCallDisplay(toolName, input);
    case "mv":
      return buildMvCallDisplay(toolName, input);
    case "git":
      return buildGitCallDisplay(toolName, input);
    case "bash":
      return buildBashCallDisplay(toolName, input);
    case "todo_list":
    case "todo_add":
    case "todo_update":
    case "todo_complete":
    case "todo_reopen":
    case "todo_remove":
    case "todo_clear_done":
      return buildTodoCallDisplay(toolName, input);
    case "webfetch":
      return buildWebfetchCallDisplay(toolName, input);
    default:
      return undefined;
  }
};

export const buildToolResultDisplay = (
  toolName: string,
  input: unknown,
  result: unknown,
  errorMessage?: string,
): ToolDisplayEnvelope | undefined => {
  const inputRecord = isRecord(input) ? input : undefined;

  if (toolName === "webfetch") {
    return buildWebfetchResultDisplay(toolName, inputRecord, result, errorMessage);
  }

  if (!isRecord(result)) {
    return undefined;
  }

  switch (toolName) {
    case "read":
      return buildReadResultDisplay(toolName, inputRecord, result, errorMessage);
    case "write":
      return buildWriteResultDisplay(toolName, inputRecord, result, errorMessage);
    case "ls":
      return buildLsResultDisplay(toolName, inputRecord, result, errorMessage);
    case "tree":
      return buildTreeResultDisplay(toolName, inputRecord, result, errorMessage);
    case "ripgrep":
      return buildRipgrepResultDisplay(toolName, result, errorMessage);
    case "cp":
      return buildCpResultDisplay(toolName, result, errorMessage);
    case "mv":
      return buildMvResultDisplay(toolName, result, errorMessage);
    case "git":
      return buildGitResultDisplay(toolName, inputRecord, result, errorMessage);
    case "bash":
      return buildBashResultDisplay(toolName, inputRecord, result, errorMessage);
    case "todo_list":
    case "todo_add":
    case "todo_update":
    case "todo_complete":
    case "todo_reopen":
    case "todo_remove":
    case "todo_clear_done":
      return buildTodoResultDisplay(toolName, inputRecord, result, errorMessage);
    default:
      return undefined;
  }
};
