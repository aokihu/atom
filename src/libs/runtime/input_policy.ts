import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentExecutionInputPolicyConfig } from "../../types/agent";

export type ResolvedTaskInputPolicyConfig = {
  enabled: boolean;
  maxInputTokens: number;
  summarizeTargetTokens: number;
  spoolOriginalInput: boolean;
  spoolDirectory: string;
};

export type TaskInputIngressMeta = {
  compressed: boolean;
  originalBytes: number;
  summaryBytes: number;
  spooledPath?: string;
  estimatedInputTokens: number;
};

export type TaskInputPolicyApplyResult = {
  input: string;
  ingress: TaskInputIngressMeta;
};

export const DEFAULT_TASK_INPUT_POLICY_CONFIG: ResolvedTaskInputPolicyConfig = {
  enabled: true,
  maxInputTokens: 12000,
  summarizeTargetTokens: 2200,
  spoolOriginalInput: true,
  spoolDirectory: ".agent/inbox",
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
};

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeSpoolDirectory = (value: unknown): string => {
  const normalized = toNonEmptyString(value);
  if (!normalized) {
    return DEFAULT_TASK_INPUT_POLICY_CONFIG.spoolDirectory;
  }
  return normalized.replace(/\\/g, "/");
};

export const resolveTaskInputPolicyConfig = (
  config?: AgentExecutionInputPolicyConfig,
): ResolvedTaskInputPolicyConfig => ({
  enabled: config?.enabled ?? DEFAULT_TASK_INPUT_POLICY_CONFIG.enabled,
  maxInputTokens: clampInteger(
    config?.maxInputTokens,
    DEFAULT_TASK_INPUT_POLICY_CONFIG.maxInputTokens,
    256,
    2_000_000,
  ),
  summarizeTargetTokens: clampInteger(
    config?.summarizeTargetTokens,
    DEFAULT_TASK_INPUT_POLICY_CONFIG.summarizeTargetTokens,
    128,
    200_000,
  ),
  spoolOriginalInput: config?.spoolOriginalInput ?? DEFAULT_TASK_INPUT_POLICY_CONFIG.spoolOriginalInput,
  spoolDirectory: normalizeSpoolDirectory(config?.spoolDirectory),
});

const urlRegex = /https?:\/\/\S+/i;
const codeFenceRegex = /```|^\s{2,}\S/;
const stackRegex = /\bat\b .*:\d+:\d+|\b(traceback|exception|error)\b/i;
const numericSignalRegex = /(?:\d{2,}|[A-Fa-f0-9]{8,}|\b\d+\.\d+\b)/;

const hasSignal = (line: string): boolean =>
  urlRegex.test(line) ||
  codeFenceRegex.test(line) ||
  stackRegex.test(line) ||
  numericSignalRegex.test(line);

const dedupeConsecutiveLines = (lines: string[]): string[] => {
  const result: string[] = [];
  let previous: string | null = null;
  for (const line of lines) {
    const normalized = line.trimEnd();
    if (previous !== null && normalized === previous) {
      continue;
    }
    result.push(line);
    previous = normalized;
  }
  return result;
};

export const estimateTextTokens = (text: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));

type DeterministicCompressOptions = {
  targetTokens: number;
};

export const compressTextDeterministic = (
  input: string,
  options: DeterministicCompressOptions,
): string => {
  const sourceLines = dedupeConsecutiveLines(input.split(/\r?\n/));
  if (sourceLines.length === 0) {
    return input;
  }

  const keepHead = Math.max(1, Math.floor(sourceLines.length * 0.2));
  const keepTail = Math.max(1, Math.floor(sourceLines.length * 0.2));
  const selected = new Set<number>();

  for (let i = 0; i < Math.min(keepHead, sourceLines.length); i += 1) {
    selected.add(i);
  }
  for (let i = Math.max(0, sourceLines.length - keepTail); i < sourceLines.length; i += 1) {
    selected.add(i);
  }
  for (let i = 0; i < sourceLines.length; i += 1) {
    if (hasSignal(sourceLines[i] ?? "")) {
      selected.add(i);
    }
  }

  const prioritizedIndices = [...selected].sort((a, b) => a - b);
  let compacted = prioritizedIndices.map((index) => sourceLines[index] ?? "");

  if (compacted.length === 0) {
    compacted = sourceLines.slice(0, Math.max(1, Math.min(sourceLines.length, 64)));
  }

  let summary = compacted.join("\n");
  let stride = 2;
  while (estimateTextTokens(summary) > options.targetTokens && compacted.length > 1 && stride <= 12) {
    const reduced: string[] = [];
    for (let index = 0; index < compacted.length; index += 1) {
      const line = compacted[index] ?? "";
      const alwaysKeep = index === 0 || index === compacted.length - 1 || hasSignal(line);
      if (alwaysKeep || index % stride === 0) {
        reduced.push(line);
      }
    }

    if (reduced.length === compacted.length) {
      stride += 1;
      continue;
    }

    compacted = reduced;
    summary = compacted.join("\n");
  }

  return summary.trim();
};

const buildCompactedTaskInput = (args: {
  summary: string;
  originalTokens: number;
  summaryTokens: number;
  originalBytes: number;
  spooledPath?: string;
}) =>
  [
    "[input_policy] Original task input exceeded token budget and was compacted.",
    `original_estimated_tokens=${args.originalTokens}`,
    `summary_estimated_tokens=${args.summaryTokens}`,
    `original_bytes=${args.originalBytes}`,
    `original_path=${args.spooledPath ?? "(unavailable)"}`,
    "",
    "Use the summary below as primary context. Read original_path only when necessary.",
    "<<<SUMMARY>>>",
    args.summary,
  ].join("\n");

const resolveSpoolPath = (workspace: string, spoolDirectory: string, taskId: string): string => {
  if (isAbsolute(spoolDirectory)) {
    return resolve(spoolDirectory, `${taskId}.txt`);
  }
  return resolve(workspace, spoolDirectory, `${taskId}.txt`);
};

export class TaskInputPolicy {
  readonly config: ResolvedTaskInputPolicyConfig;

  constructor(config?: AgentExecutionInputPolicyConfig) {
    this.config = resolveTaskInputPolicyConfig(config);
  }

  apply(args: {
    input: string;
    taskId: string;
    workspace: string;
  }): TaskInputPolicyApplyResult {
    const originalBytes = Buffer.byteLength(args.input, "utf8");
    const originalTokens = estimateTextTokens(args.input);
    if (!this.config.enabled || originalTokens <= this.config.maxInputTokens) {
      return {
        input: args.input,
        ingress: {
          compressed: false,
          originalBytes,
          summaryBytes: originalBytes,
          estimatedInputTokens: originalTokens,
        },
      };
    }

    const summary = compressTextDeterministic(args.input, {
      targetTokens: this.config.summarizeTargetTokens,
    });
    const summaryTokens = estimateTextTokens(summary);
    let spooledPath: string | undefined;
    if (this.config.spoolOriginalInput) {
      const filepath = resolveSpoolPath(args.workspace, this.config.spoolDirectory, args.taskId);
      try {
        mkdirSync(dirname(filepath), { recursive: true });
        writeFileSync(filepath, args.input, "utf8");
        spooledPath = filepath;
      } catch {
        spooledPath = undefined;
      }
    }

    const compactedInput = buildCompactedTaskInput({
      summary,
      originalTokens,
      summaryTokens,
      originalBytes,
      spooledPath,
    });

    return {
      input: compactedInput,
      ingress: {
        compressed: true,
        originalBytes,
        summaryBytes: Buffer.byteLength(compactedInput, "utf8"),
        spooledPath,
        estimatedInputTokens: originalTokens,
      },
    };
  }
}
