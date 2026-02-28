import {
  generateText,
  streamText,
  type ModelMessage,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { AgentModelParams } from "../../../types/agent";
import type { ToolDefinitionMap } from "../tools";
import { ToolBudgetExceededError } from "../tools/types";
import {
  emitOutputMessage,
  type AgentOutputMessageSink,
  toOutputErrorMessage,
} from "./output_messages";

export type ModelExecutionInput = {
  model: LanguageModelV3;
  messages: ModelMessage[];
  modelParams?: AgentModelParams;
  abortSignal?: AbortSignal;
  tools: ToolDefinitionMap;
  stopWhen: any;
  onOutputMessage?: AgentOutputMessageSink;
  emitFinalAssistantText?: boolean;
  emitTaskFinishMessage?: boolean;
};

export type ModelExecutionResult = {
  text: string;
  finishReason: string;
  stepCount: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
};

const toOptionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeTokenUsage = (raw: unknown): ModelExecutionResult["tokenUsage"] => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const usage = raw as Record<string, unknown>;
  const inputTokens =
    toOptionalNumber(usage.inputTokens) ?? toOptionalNumber(usage.promptTokens);
  const outputTokens =
    toOptionalNumber(usage.outputTokens) ?? toOptionalNumber(usage.completionTokens);
  const totalTokens = toOptionalNumber(usage.totalTokens);
  const reasoningTokens = toOptionalNumber(usage.reasoningTokens);
  const cachedInputTokens = toOptionalNumber(usage.cachedInputTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
  };
};

export class AISDKModelExecutor {
  async generate(input: ModelExecutionInput): Promise<ModelExecutionResult> {
    let stepCount = 0;

    try {
      const result = await generateText({
        model: input.model,
        messages: input.messages,
        ...input.modelParams,
        abortSignal: input.abortSignal,
        tools: input.tools,
        stopWhen: input.stopWhen,
        onStepFinish: async (stepResult) => {
          stepCount += 1;

          emitOutputMessage(input.onOutputMessage, {
            category: "other",
            type: "step.finish",
            step: stepCount,
            finishReason: String(stepResult.finishReason),
            text: `Step ${stepCount} finished (${String(stepResult.finishReason)})`,
          });
        },
      });

      if (input.emitFinalAssistantText !== false) {
        emitOutputMessage(input.onOutputMessage, {
          category: "assistant",
          type: "assistant.text",
          text: result.text,
          final: true,
        });
      }

      if (input.emitTaskFinishMessage !== false) {
        emitOutputMessage(input.onOutputMessage, {
          category: "other",
          type: "task.finish",
          finishReason: String(result.finishReason),
          text: `Task finished (${String(result.finishReason)})`,
        });
      }

      return {
        text: result.text,
        finishReason: String(result.finishReason),
        stepCount,
        tokenUsage:
          normalizeTokenUsage((result as unknown as { usage?: unknown }).usage) ??
          normalizeTokenUsage((result as unknown as { totalUsage?: unknown }).totalUsage),
      };
    } catch (error) {
      if (error instanceof ToolBudgetExceededError) {
        throw error;
      }

      emitOutputMessage(input.onOutputMessage, {
        category: "other",
        type: "task.error",
        text: toOutputErrorMessage(error),
      });
      throw error;
    }
  }

  stream(input: ModelExecutionInput) {
    let stepCount = 0;

    return streamText({
      model: input.model,
      messages: input.messages,
      ...input.modelParams,
      abortSignal: input.abortSignal,
      tools: input.tools,
      stopWhen: input.stopWhen,
      onStepFinish: async (stepResult) => {
        stepCount += 1;

        emitOutputMessage(input.onOutputMessage, {
          category: "other",
          type: "step.finish",
          step: stepCount,
          finishReason: String(stepResult.finishReason),
          text: `Step ${stepCount} finished (${String(stepResult.finishReason)})`,
        });
      },
      onFinish: async (result) => {
        emitOutputMessage(input.onOutputMessage, {
          category: "assistant",
          type: "assistant.text",
          text: result.text,
          final: true,
        });

        emitOutputMessage(input.onOutputMessage, {
          category: "other",
          type: "task.finish",
          finishReason: String(result.finishReason),
          text: `Task finished (${String(result.finishReason)})`,
        });
      },
      onError: async ({ error }) => {
        emitOutputMessage(input.onOutputMessage, {
          category: "other",
          type: "task.error",
          text: toOutputErrorMessage(error),
        });
      },
    });
  }
}
