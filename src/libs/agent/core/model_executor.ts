import {
  generateText,
  streamText,
  type StreamTextOnToolCallFinishCallback,
  type StreamTextOnToolCallStartCallback,
  type ModelMessage,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { AgentModelParams } from "../../../types/agent";
import type { ToolDefinitionMap } from "../tools";
import { buildToolCallDisplay, buildToolResultDisplay } from "../tools/tool_display";
import { getToolErrorMessageFromOutput } from "../tools/tool_output_error";
import { ToolBudgetExceededError, ToolPolicyBlockedError } from "../tools/types";
import {
  emitOutputMessage,
  type AgentOutputMessageSink,
  summarizeOutputValue,
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
  emitFinalAssistantText?: boolean;
  emitTaskFinishMessage?: boolean;
};

export type ModelExecutionResult = {
  text: string;
  finishReason: string;
  stepCount: number;
};

type GenerateTextFn = typeof generateText;
type StreamTextFn = typeof streamText;

type AISDKModelExecutorDeps = {
  generateTextFn?: GenerateTextFn;
  streamTextFn?: StreamTextFn;
};

type ToolHookCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ToolCallStartEventLike = {
  stepNumber?: number;
  toolCall: ToolHookCall;
};

type ToolCallFinishEventLike = ToolCallStartEventLike & (
  | {
      success: true;
      output: unknown;
    }
  | {
      success: false;
      error: unknown;
    }
);

// AI_SDK_EXPERIMENTAL_HOOK_IN_USE: experimental_onToolCallStart/Finish
// SDK upgrade check required: verify option names and callback event shape on ai package updates.
// Check: stepNumber presence + 0-based indexing, toolCall(toolCallId/toolName/input), success/output/error, durationMs.
export class AISDKModelExecutor {
  private readonly generateTextFn: GenerateTextFn;
  private readonly streamTextFn: StreamTextFn;

  constructor(deps: AISDKModelExecutorDeps = {}) {
    this.generateTextFn = deps.generateTextFn ?? generateText;
    this.streamTextFn = deps.streamTextFn ?? streamText;
  }

  private toInternalStepNumber(stepNumber: number | undefined): number | undefined {
    if (typeof stepNumber !== "number" || !Number.isFinite(stepNumber)) return undefined;
    return stepNumber + 1;
  }

  private buildToolCallStartHook(
    sink: AgentOutputMessageSink | undefined,
  ): StreamTextOnToolCallStartCallback<any> {
    return async (event) => {
      try {
        this.emitToolCallStartMessage(sink, event as ToolCallStartEventLike);
      } catch {
        // Observability hooks must not break generation.
      }
    };
  }

  private buildToolCallFinishHook(
    sink: AgentOutputMessageSink | undefined,
  ): StreamTextOnToolCallFinishCallback<any> {
    return async (event) => {
      try {
        this.emitToolCallFinishMessage(sink, event as ToolCallFinishEventLike);
      } catch {
        // Observability hooks must not break generation.
      }
    };
  }

  private emitToolCallStartMessage(
    sink: AgentOutputMessageSink | undefined,
    event: ToolCallStartEventLike,
  ): void {
    const toolName = String(event.toolCall.toolName);
    const toolInput = event.toolCall.input;

    emitOutputMessage(sink, {
      category: "tool",
      type: "tool.call",
      step: this.toInternalStepNumber(event.stepNumber),
      toolCallId: event.toolCall.toolCallId,
      toolName,
      inputSummary: summarizeOutputValue(toolInput),
      inputDisplay: buildToolCallDisplay(toolName, toolInput),
    });
  }

  private emitToolCallFinishMessage(
    sink: AgentOutputMessageSink | undefined,
    event: ToolCallFinishEventLike,
  ): void {
    const toolName = String(event.toolCall.toolName);
    const toolInput = event.toolCall.input;
    const step = this.toInternalStepNumber(event.stepNumber);

    if (!event.success) {
      const errorMessage = toOutputErrorMessage(event.error);
      emitOutputMessage(sink, {
        category: "tool",
        type: "tool.result",
        step,
        toolCallId: event.toolCall.toolCallId,
        toolName,
        ok: false,
        errorMessage,
        outputDisplay: buildToolResultDisplay(toolName, toolInput, { error: errorMessage }, errorMessage),
      });
      return;
    }

    const semanticErrorMessage = getToolErrorMessageFromOutput(event.output);
    emitOutputMessage(sink, {
      category: "tool",
      type: "tool.result",
      step,
      toolCallId: event.toolCall.toolCallId,
      toolName,
      ok: semanticErrorMessage === undefined,
      outputSummary: summarizeOutputValue(event.output),
      errorMessage: semanticErrorMessage,
      outputDisplay: buildToolResultDisplay(toolName, toolInput, event.output, semanticErrorMessage),
    });
  }

  async generate(input: ModelExecutionInput): Promise<ModelExecutionResult> {
    let stepCount = 0;

    try {
      const result = await this.generateTextFn({
        model: input.model,
        messages: input.messages,
        ...input.modelParams,
        abortSignal: input.abortSignal,
        tools: input.tools,
        stopWhen: input.stopWhen,
        experimental_onToolCallStart: this.buildToolCallStartHook(input.onOutputMessage),
        experimental_onToolCallFinish: this.buildToolCallFinishHook(input.onOutputMessage),
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

      input.onUsage?.((result as { usage?: unknown }).usage);

      return {
        text: result.text,
        finishReason: String(result.finishReason),
        stepCount,
      };
    } catch (error) {
      if (error instanceof ToolBudgetExceededError || error instanceof ToolPolicyBlockedError) {
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

    return this.streamTextFn({
      model: input.model,
      messages: input.messages,
      ...input.modelParams,
      abortSignal: input.abortSignal,
      tools: input.tools,
      stopWhen: input.stopWhen,
      experimental_onToolCallStart: this.buildToolCallStartHook(input.onOutputMessage),
      experimental_onToolCallFinish: this.buildToolCallFinishHook(input.onOutputMessage),
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

        input.onUsage?.((result as { usage?: unknown }).usage);
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
