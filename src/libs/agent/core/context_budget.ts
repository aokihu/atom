import type { ModelMessage } from "ai";
import type {
  AgentContextRuntime,
  AgentModelParams,
  ContextMemoryTier,
  ResolvedAgentExecutionContextBudgetConfig,
} from "../../../types/agent";
import type { AgentSession } from "../session/agent_session";

type TierCounts = Record<ContextMemoryTier, number>;

type MemoryTrimState = {
  counts: TierCounts;
  stage: string;
};

export type ContextBudgetApplyResult = {
  exhausted: boolean;
  question: string;
  modelParams?: AgentModelParams;
  budget: NonNullable<AgentContextRuntime["budget"]>;
};

const MEMORY_TRIM_ORDER: readonly ContextMemoryTier[] = [
  "ephemeral",
  "working",
  "longterm",
  "core",
];

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
};

const estimateTokensByBytes = (text: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));

const extractTextFromContentPart = (part: unknown): string => {
  if (typeof part === "string") {
    return part;
  }
  if (typeof part !== "object" || part === null) {
    return "";
  }
  const text = (part as Record<string, unknown>).text;
  if (typeof text === "string") {
    return text;
  }
  return "";
};

const messageContentToText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => extractTextFromContentPart(part))
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    return JSON.stringify(content);
  }
  return String(content ?? "");
};

export const estimateMessageTokens = (messages: ModelMessage[]): number =>
  messages.reduce((sum, message) => {
    const messageText = messageContentToText((message as { content?: unknown }).content);
    return sum + estimateTokensByBytes(messageText);
  }, 0);

const dedupeConsecutiveLines = (lines: string[]): string[] => {
  const result: string[] = [];
  let previous: string | null = null;
  for (const line of lines) {
    const normalized = line.trimEnd();
    if (previous !== null && normalized === previous) {
      continue;
    }
    previous = normalized;
    result.push(line);
  }
  return result;
};

const urlRegex = /https?:\/\/\S+/i;
const stackRegex = /\bat\b .*:\d+:\d+|\b(traceback|exception|error)\b/i;
const codeFenceRegex = /```|^\s{2,}\S/;
const numericSignalRegex = /(?:\d{2,}|[A-Fa-f0-9]{8,}|\b\d+\.\d+\b)/;

const hasSignal = (line: string): boolean =>
  urlRegex.test(line) ||
  stackRegex.test(line) ||
  codeFenceRegex.test(line) ||
  numericSignalRegex.test(line);

const compressUserTextDeterministic = (input: string, targetTokens: number): string => {
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

  let compacted = [...selected]
    .sort((a, b) => a - b)
    .map((index) => sourceLines[index] ?? "");
  if (compacted.length === 0) {
    compacted = sourceLines.slice(0, Math.min(sourceLines.length, 80));
  }

  let summary = compacted.join("\n");
  let stride = 2;
  while (estimateTokensByBytes(summary) > targetTokens && compacted.length > 1 && stride <= 12) {
    const reduced: string[] = [];
    for (let index = 0; index < compacted.length; index += 1) {
      const line = compacted[index] ?? "";
      const mustKeep = index === 0 || index === compacted.length - 1 || hasSignal(line);
      if (mustKeep || index % stride === 0) {
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

  return [
    "[context_budget] User input was compacted to fit runtime context budget.",
    "<<<SUMMARY>>>",
    summary.trim(),
  ].join("\n");
};

const toTierCounts = (session: AgentSession): TierCounts => {
  const memory = session.getContextSnapshot().memory;
  return {
    core: memory.core.length,
    working: memory.working.length,
    ephemeral: memory.ephemeral.length,
    longterm: memory.longterm.length,
  };
};

const trimMemoryOnce = (
  counts: TierCounts,
  config: ResolvedAgentExecutionContextBudgetConfig,
): MemoryTrimState | null => {
  for (const tier of MEMORY_TRIM_ORDER) {
    const current = counts[tier];
    const min = config.minMemoryItems[tier];
    if (current <= min) {
      continue;
    }
    const next = {
      ...counts,
      [tier]: Math.max(min, current - config.memoryTrimStep),
    };
    return {
      counts: next,
      stage: `trim_memory_${tier}`,
    };
  }
  return null;
};

const computeSafetyMarginTokens = (config: ResolvedAgentExecutionContextBudgetConfig): number =>
  Math.max(
    config.safetyMarginMinTokens,
    Math.round(config.contextWindowTokens * config.safetyMarginRatio),
  );

const computeReserveOutputTokens = (
  modelParams: AgentModelParams | undefined,
  config: ResolvedAgentExecutionContextBudgetConfig,
): number => {
  const requested = clampInteger(
    modelParams?.maxOutputTokens,
    config.reserveOutputTokensCap,
    1,
    config.contextWindowTokens,
  );
  return Math.min(requested, config.reserveOutputTokensCap);
};

const normalizeDownshiftCandidates = (
  config: ResolvedAgentExecutionContextBudgetConfig,
): number[] => {
  const unique = new Set<number>();
  for (const item of config.outputTokenDownshifts) {
    unique.add(clampInteger(item, 512, 1, config.contextWindowTokens));
  }
  return [...unique].sort((a, b) => b - a);
};

const buildBudgetTelemetry = (args: {
  estimatedInputTokens: number;
  inputBudget: number;
  reserveOutputTokens: number;
  safetyMarginTokens: number;
  degradeStage: string;
  outputLimitTokens?: number;
}): NonNullable<AgentContextRuntime["budget"]> => ({
  estimated_input_tokens: args.estimatedInputTokens,
  input_budget: args.inputBudget,
  reserve_output_tokens: args.reserveOutputTokens,
  safety_margin_tokens: args.safetyMarginTokens,
  degrade_stage: args.degradeStage,
  ...(typeof args.outputLimitTokens === "number"
    ? { output_limit_tokens: args.outputLimitTokens }
    : {}),
});

export class ContextBudgetOrchestrator {
  constructor(private readonly config: ResolvedAgentExecutionContextBudgetConfig) {}

  apply(args: {
    session: AgentSession;
    question: string;
    modelParams?: AgentModelParams;
  }): ContextBudgetApplyResult {
    const safetyMarginTokens = computeSafetyMarginTokens(this.config);
    let nextQuestion = args.question;
    let nextModelParams = args.modelParams ? { ...args.modelParams } : undefined;
    let degradeStage = "none";

    const estimateCurrentInput = () => estimateMessageTokens(args.session.getMessagesSnapshot());
    const computeInputBudget = (reserveOutputTokens: number): number =>
      this.config.contextWindowTokens - reserveOutputTokens - safetyMarginTokens;

    let reserveOutputTokens = computeReserveOutputTokens(nextModelParams, this.config);
    let inputBudget = computeInputBudget(reserveOutputTokens);
    let estimatedInputTokens = estimateCurrentInput();

    if (!this.config.enabled) {
      return {
        exhausted: false,
        question: nextQuestion,
        modelParams: nextModelParams,
        budget: buildBudgetTelemetry({
          estimatedInputTokens,
          inputBudget,
          reserveOutputTokens,
          safetyMarginTokens,
          degradeStage: "disabled",
          outputLimitTokens: nextModelParams?.maxOutputTokens,
        }),
      };
    }

    if (estimatedInputTokens > inputBudget) {
      let memoryCounts = toTierCounts(args.session);
      while (estimatedInputTokens > inputBudget) {
        const trimmed = trimMemoryOnce(memoryCounts, this.config);
        if (!trimmed) {
          break;
        }
        memoryCounts = trimmed.counts;
        degradeStage = trimmed.stage;
        args.session.applyMemoryTierLimits(memoryCounts);
        args.session.refreshInjectedContext({ advanceRound: false });
        estimatedInputTokens = estimateCurrentInput();
      }
    }

    if (estimatedInputTokens > inputBudget) {
      const compactedQuestion = compressUserTextDeterministic(
        nextQuestion,
        this.config.secondaryCompressTargetTokens,
      );
      if (compactedQuestion.trim() !== "" && compactedQuestion !== nextQuestion) {
        const replaced = args.session.replaceLatestUserMessage(compactedQuestion);
        if (replaced) {
          nextQuestion = compactedQuestion;
          degradeStage = "compress_user_input";
          estimatedInputTokens = estimateCurrentInput();
        }
      }
    }

    if (estimatedInputTokens > inputBudget) {
      const downshifts = normalizeDownshiftCandidates(this.config);
      const requestedOutputTokens = clampInteger(
        nextModelParams?.maxOutputTokens,
        this.config.reserveOutputTokensCap,
        1,
        this.config.contextWindowTokens,
      );
      let currentReserve = Math.min(requestedOutputTokens, this.config.reserveOutputTokensCap);

      for (const candidate of downshifts) {
        if (candidate >= currentReserve) {
          continue;
        }
        nextModelParams = {
          ...(nextModelParams ?? {}),
          maxOutputTokens: candidate,
        };
        reserveOutputTokens = computeReserveOutputTokens(nextModelParams, this.config);
        inputBudget = computeInputBudget(reserveOutputTokens);
        currentReserve = reserveOutputTokens;
        degradeStage = `downshift_output_${candidate}`;
        if (estimatedInputTokens <= inputBudget) {
          break;
        }
      }
    }

    reserveOutputTokens = computeReserveOutputTokens(nextModelParams, this.config);
    inputBudget = computeInputBudget(reserveOutputTokens);
    const exhausted = estimatedInputTokens > inputBudget;
    if (exhausted) {
      degradeStage = "context_budget_exhausted";
    }

    return {
      exhausted,
      question: nextQuestion,
      modelParams: nextModelParams,
      budget: buildBudgetTelemetry({
        estimatedInputTokens,
        inputBudget,
        reserveOutputTokens,
        safetyMarginTokens,
        degradeStage,
        outputLimitTokens: nextModelParams?.maxOutputTokens,
      }),
    };
  }
}

export const __contextBudgetInternals = {
  estimateTokensByBytes,
  estimateMessageTokens,
  compressUserTextDeterministic,
  computeSafetyMarginTokens,
  computeReserveOutputTokens,
  normalizeDownshiftCandidates,
  trimMemoryOnce,
};
