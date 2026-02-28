import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type InputPolicyConfig = {
  enabled: boolean;
  autoCompress: boolean;
  maxInputTokens: number;
  summarizeTargetTokens: number;
};

export type InputIngressMetadata = {
  compressed: boolean;
  originalBytes: number;
  summaryBytes: number;
  estimatedInputTokens: number;
  spooledPath?: string;
};

export type InputPolicyResult = {
  input: string;
  ingress: InputIngressMetadata;
};

const CODE_BLOCK_PATTERN = /^\s*```/;
const URL_PATTERN = /https?:\/\//i;
const STACK_PATTERN = /\bat\s+.+\(.+\)/i;
const DIGIT_PATTERN = /\d/;
const ERROR_PATTERN = /(error|exception|traceback|failed|failure)/i;

const toLines = (text: string): string[] => text.replace(/\r\n/g, "\n").split("\n");

export const estimateTextTokens = (text: string): number => {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
};

const dedupeConsecutive = (lines: string[]): string[] => {
  const next: string[] = [];
  let previous = "";
  for (const line of lines) {
    if (line === previous) {
      continue;
    }
    next.push(line);
    previous = line;
  }
  return next;
};

const scoreLine = (line: string): number => {
  let score = 0;
  if (URL_PATTERN.test(line)) score += 4;
  if (STACK_PATTERN.test(line)) score += 3;
  if (CODE_BLOCK_PATTERN.test(line)) score += 2;
  if (ERROR_PATTERN.test(line)) score += 2;
  if (DIGIT_PATTERN.test(line)) score += 1;
  if (line.trim().length > 120) score += 1;
  return score;
};

const compressInputDeterministically = (text: string, targetTokens: number): string => {
  const lines = dedupeConsecutive(toLines(text));
  if (lines.length === 0) {
    return "";
  }

  const headCount = Math.max(1, Math.floor(lines.length * 0.2));
  const tailCount = Math.max(1, Math.floor(lines.length * 0.2));

  const selected = new Set<number>();
  for (let i = 0; i < headCount; i += 1) {
    selected.add(i);
  }
  for (let i = 0; i < tailCount; i += 1) {
    selected.add(lines.length - 1 - i);
  }

  const middleCandidates: Array<{ index: number; score: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (selected.has(index)) continue;
    middleCandidates.push({ index, score: scoreLine(lines[index] ?? "") });
  }

  middleCandidates
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    })
    .slice(0, Math.max(0, Math.floor(lines.length * 0.2)))
    .forEach((item) => selected.add(item.index));

  const ordered = Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => lines[index] ?? "")
    .filter((line) => line.length > 0);

  if (ordered.length === 0) {
    return lines.slice(0, Math.max(1, Math.min(lines.length, 12))).join("\n");
  }

  const targetChars = Math.max(200, Math.ceil(targetTokens * 3.8));
  const chunks: string[] = [];
  let used = 0;

  for (const line of ordered) {
    const nextLength = used + line.length + 1;
    if (nextLength > targetChars && chunks.length > 0) {
      break;
    }
    chunks.push(line);
    used = nextLength;
  }

  return chunks.join("\n");
};

const spoolOriginalInput = (workspace: string, taskId: string, input: string): string => {
  const filepath = resolve(join(workspace, ".agent", "inbox", `${taskId}.txt`));
  mkdirSync(dirname(filepath), { recursive: true });
  writeFileSync(filepath, input, "utf8");
  return filepath;
};

const buildCompressedEnvelope = (summary: string, spooledPath: string, estimatedTokens: number): string =>
  [
    "[INPUT_COMPRESSED]",
    `Estimated original input tokens: ${estimatedTokens}`,
    `Original input has been spooled to: ${spooledPath}`,
    "Use the summary below first; read the spooled file only when needed.",
    "",
    "Summary:",
    summary,
  ].join("\n");

export const applyTaskInputPolicy = (args: {
  taskId: string;
  workspace: string;
  input: string;
  config: InputPolicyConfig;
}): InputPolicyResult => {
  const originalBytes = Buffer.byteLength(args.input, "utf8");
  const estimatedInputTokens = estimateTextTokens(args.input);

  if (!args.config.enabled || !args.config.autoCompress || estimatedInputTokens <= args.config.maxInputTokens) {
    return {
      input: args.input,
      ingress: {
        compressed: false,
        originalBytes,
        summaryBytes: originalBytes,
        estimatedInputTokens,
      },
    };
  }

  const summary = compressInputDeterministically(args.input, args.config.summarizeTargetTokens);
  const spooledPath = spoolOriginalInput(args.workspace, args.taskId, args.input);
  const rewritten = buildCompressedEnvelope(summary, spooledPath, estimatedInputTokens);

  return {
    input: rewritten,
    ingress: {
      compressed: true,
      originalBytes,
      summaryBytes: Buffer.byteLength(summary, "utf8"),
      estimatedInputTokens,
      spooledPath,
    },
  };
};

export const __inputPolicyInternals = {
  compressInputDeterministically,
  dedupeConsecutive,
};
