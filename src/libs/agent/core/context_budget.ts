import type { ModelMessage } from "ai";
import type {
  AgentContext,
  ResolvedAgentExecutionContextBudgetConfig,
  RuntimeBudgetSnapshot,
} from "../../../types/agent";
import type { ContextProjectionOptions } from "../session/context_projection_v2";
import { projectContextSnapshotV2 } from "../session/context_projection_v2";

export type ContextBudgetPlan = {
  stop: boolean;
  stopReason?: "context_budget_exhausted";
  projectionOptions?: ContextProjectionOptions;
  rewrittenInput?: string;
  outputLimitTokens: number;
  budget: RuntimeBudgetSnapshot;
};

const DEFAULT_CONTEXT_WINDOW_TOKENS = 131072;

const estimateTextTokens = (text: string): number => {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
};

const extractMessageText = (message: ModelMessage): string => {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        chunks.push(text);
      }
    }
  }
  return chunks.join("\n");
};

const estimateMessagesTokens = (messages: ModelMessage[]): number =>
  messages.reduce((total, message) => total + estimateTextTokens(extractMessageText(message)) + 6, 0);

const compressInput = (text: string, targetTokens: number): string => {
  if (!text) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= 6) {
    return text;
  }

  const keepHead = Math.max(2, Math.floor(lines.length * 0.25));
  const keepTail = Math.max(2, Math.floor(lines.length * 0.25));
  const middle = lines.slice(keepHead, Math.max(keepHead, lines.length - keepTail));
  const highlighted = middle.filter((line) =>
    /https?:\/\/|error|exception|traceback|\d|```|\bat\s+.+\(.+\)/i.test(line),
  );

  const merged = [
    ...lines.slice(0, keepHead),
    ...highlighted.slice(0, Math.max(2, Math.floor(lines.length * 0.2))),
    ...lines.slice(lines.length - keepTail),
  ];

  const deduped: string[] = [];
  let previous = "";
  for (const line of merged) {
    if (line === previous) continue;
    deduped.push(line);
    previous = line;
  }

  const targetChars = Math.max(180, Math.ceil(targetTokens * 3.8));
  const output: string[] = [];
  let used = 0;
  for (const line of deduped) {
    const size = line.length + 1;
    if (output.length > 0 && used + size > targetChars) {
      break;
    }
    output.push(line);
    used += size;
  }

  return output.join("\n");
};

const buildBudgetSnapshot = (args: {
  estimatedInputTokens: number;
  inputBudget: number;
  reserveOutputTokens: number;
  safetyMarginTokens: number;
  degradeStage: string;
  outputLimitTokens: number;
}): RuntimeBudgetSnapshot => ({
  estimated_input_tokens: args.estimatedInputTokens,
  input_budget: args.inputBudget,
  reserve_output_tokens: args.reserveOutputTokens,
  safety_margin_tokens: args.safetyMarginTokens,
  degrade_stage: args.degradeStage,
  output_limit_tokens: args.outputLimitTokens,
});

const computeBudget = (args: {
  contextWindowTokens: number;
  outputLimitTokens: number;
  config: ResolvedAgentExecutionContextBudgetConfig;
}) => {
  const reserveOutputTokens = Math.min(
    args.outputLimitTokens,
    args.config.reserveOutputTokensMax,
    2048,
  );
  const safetyMarginTokens = Math.max(
    args.config.safetyMarginMinTokens,
    Math.round(args.contextWindowTokens * args.config.safetyMarginRatio),
  );

  return {
    reserveOutputTokens,
    safetyMarginTokens,
    inputBudget: Math.max(1, args.contextWindowTokens - reserveOutputTokens - safetyMarginTokens),
  };
};

const buildProjectionForStage = (stage: "none" | "memory_trim", inputBudget: number): ContextProjectionOptions => {
  if (stage === "none") {
    return { tokenBudget: Math.max(256, Math.floor(inputBudget * 0.7)) };
  }

  return {
    dropTerminalWorking: true,
    tokenBudget: Math.max(128, Math.floor(inputBudget * 0.55)),
    maxItemsByTier: {
      ephemeral: 0,
      working: 16,
      longterm: 24,
      core: 24,
    },
  };
};

const estimateTotalInputTokens = (args: {
  baseMessages: ModelMessage[];
  context: AgentContext;
  projectionOptions: ContextProjectionOptions;
  userInput: string;
}) => {
  const baseTokens = estimateMessagesTokens(args.baseMessages);
  const projected = projectContextSnapshotV2(args.context, args.projectionOptions);
  const contextTokens = estimateTextTokens(JSON.stringify(projected.modelContext));
  const userTokens = estimateTextTokens(args.userInput);
  return baseTokens + contextTokens + userTokens;
};

export const planContextBudget = (args: {
  baseMessages: ModelMessage[];
  context: AgentContext;
  userInput: string;
  executionBudget: ResolvedAgentExecutionContextBudgetConfig;
  contextWindowTokens?: number;
  requestedOutputTokens: number;
}): ContextBudgetPlan => {
  const contextWindowTokens =
    args.contextWindowTokens && Number.isFinite(args.contextWindowTokens)
      ? Math.max(1024, Math.floor(args.contextWindowTokens))
      : DEFAULT_CONTEXT_WINDOW_TOKENS;

  const outputStepDown = args.executionBudget.outputStepDownTokens.length > 0
    ? args.executionBudget.outputStepDownTokens
    : [2048, 1024, 512];

  const outputCandidates = Array.from(
    new Set([
      Math.max(64, Math.floor(args.requestedOutputTokens)),
      ...outputStepDown,
    ]),
  ).sort((a, b) => b - a);

  const inputCompressed = compressInput(args.userInput, Math.max(256, Math.floor(args.executionBudget.reserveOutputTokensMax * 0.9)));

  const stageVariants: Array<{ stage: "none" | "memory_trim"; input: string; degradeLabel: string }> = [
    { stage: "none", input: args.userInput, degradeLabel: "none" },
    { stage: "memory_trim", input: args.userInput, degradeLabel: "memory_trim" },
    { stage: "memory_trim", input: inputCompressed, degradeLabel: "input_compress" },
  ];

  for (const outputLimitTokens of outputCandidates) {
    const budget = computeBudget({
      contextWindowTokens,
      outputLimitTokens,
      config: args.executionBudget,
    });

    for (const variant of stageVariants) {
      const projectionOptions = buildProjectionForStage(variant.stage, budget.inputBudget);
      const estimatedInputTokens = estimateTotalInputTokens({
        baseMessages: args.baseMessages,
        context: args.context,
        projectionOptions,
        userInput: variant.input,
      });

      if (estimatedInputTokens <= budget.inputBudget) {
        return {
          stop: false,
          projectionOptions,
          rewrittenInput: variant.input,
          outputLimitTokens,
          budget: buildBudgetSnapshot({
            estimatedInputTokens,
            inputBudget: budget.inputBudget,
            reserveOutputTokens: budget.reserveOutputTokens,
            safetyMarginTokens: budget.safetyMarginTokens,
            degradeStage:
              variant.degradeLabel === "none" && outputLimitTokens === outputCandidates[0]
                ? "none"
                : outputLimitTokens === outputCandidates[0]
                  ? variant.degradeLabel
                  : `output_${outputLimitTokens}`,
            outputLimitTokens,
          }),
        };
      }
    }
  }

  const smallestOutput = outputCandidates[outputCandidates.length - 1] ?? 512;
  const finalBudget = computeBudget({
    contextWindowTokens,
    outputLimitTokens: smallestOutput,
    config: args.executionBudget,
  });

  const estimatedInputTokens = estimateTotalInputTokens({
    baseMessages: args.baseMessages,
    context: args.context,
    projectionOptions: buildProjectionForStage("memory_trim", finalBudget.inputBudget),
    userInput: inputCompressed,
  });

  return {
    stop: true,
    stopReason: "context_budget_exhausted",
    outputLimitTokens: smallestOutput,
    budget: buildBudgetSnapshot({
      estimatedInputTokens,
      inputBudget: finalBudget.inputBudget,
      reserveOutputTokens: finalBudget.reserveOutputTokens,
      safetyMarginTokens: finalBudget.safetyMarginTokens,
      degradeStage: "exhausted",
      outputLimitTokens: smallestOutput,
    }),
  };
};
