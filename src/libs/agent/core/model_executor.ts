import {
  generateText,
  streamText,
  type ModelMessage,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ToolDefinitionMap } from "../tools";

export type ModelExecutionInput = {
  model: LanguageModelV3;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
  tools: ToolDefinitionMap;
  stopWhen: any;
};

export class AISDKModelExecutor {
  async generate(input: ModelExecutionInput): Promise<string> {
    const { text } = await generateText({
      model: input.model,
      messages: input.messages,
      abortSignal: input.abortSignal,
      tools: input.tools,
      stopWhen: input.stopWhen,
    });

    return text;
  }

  stream(input: ModelExecutionInput) {
    return streamText({
      model: input.model,
      messages: input.messages,
      abortSignal: input.abortSignal,
      tools: input.tools,
      stopWhen: input.stopWhen,
    });
  }
}
