import {
  generateText,
  streamText,
  type ModelMessage,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { AgentModelParams } from "../../../types/agent";
import type { ToolDefinitionMap } from "../tools";
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
  onUsage?: (usage: unknown) => void;
};

export class AISDKModelExecutor {
  async generate(input: ModelExecutionInput): Promise<string> {
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

      input.onUsage?.(result.usage);

      return result.text;
    } catch (error) {
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

        input.onUsage?.(result.usage);
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
