import {
  stepCountIs,
  wrapLanguageModel,
} from "ai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";

import { extractContextMiddleware } from "../../utils/ai-sdk/middlewares/extractContextMiddleware";
import type { AgentContext } from "../../../types/agent";
import type { AgentModelParams } from "../../../types/agent";
import {
  createToolRegistry,
  type ToolDefinitionMap,
  type ToolExecutionContext,
} from "../tools";
import { AgentSession } from "../session/agent_session";
import { AISDKModelExecutor } from "./model_executor";
import type { AgentOutputMessageSink } from "./output_messages";

export type AgentDependencies = {
  modelExecutor?: AISDKModelExecutor;
  createAbortController?: () => AbortController;
  createToolRegistry?: (args: {
    context: ToolExecutionContext;
    mcpTools?: ToolDefinitionMap;
  }) => ToolDefinitionMap;
  createExtractContextMiddleware?: (
    onExtractContext: (context: Partial<AgentContext>) => void,
  ) => LanguageModelV3Middleware;
  maxSteps?: number;
};

export type AgentRunOptions = {
  onOutputMessage?: AgentOutputMessageSink;
};

export class AgentRunner {
  private currentAbortController: AbortController | null = null;
  private readonly modelExecutor: AISDKModelExecutor;
  private readonly createToolRegistry: (args: {
    context: ToolExecutionContext;
    mcpTools?: ToolDefinitionMap;
  }) => ToolDefinitionMap;
  private readonly baseToolContext: ToolExecutionContext;
  private readonly mcpTools?: ToolDefinitionMap;
  private readonly createExtractContextMiddleware: (
    onExtractContext: (context: Partial<AgentContext>) => void,
  ) => LanguageModelV3Middleware;
  private readonly maxSteps: number;

  constructor(args: {
    model: LanguageModelV3;
    modelParams?: AgentModelParams;
    toolContext?: ToolExecutionContext;
    mcpTools?: ToolDefinitionMap;
    dependencies?: AgentDependencies;
  }) {
    this.model = args.model;
    this.modelParams = args.modelParams;
    const deps = args.dependencies ?? {};

    this.createAbortController = deps.createAbortController ?? (() => new AbortController());
    this.modelExecutor = deps.modelExecutor ?? new AISDKModelExecutor();
    this.createToolRegistry = deps.createToolRegistry ?? createToolRegistry;
    this.baseToolContext = args.toolContext ?? {};
    this.mcpTools = args.mcpTools;
    this.createExtractContextMiddleware =
      deps.createExtractContextMiddleware ?? extractContextMiddleware;
    this.maxSteps = deps.maxSteps ?? 10;
  }

  private readonly model: LanguageModelV3;
  private readonly modelParams?: AgentModelParams;
  private readonly createAbortController: () => AbortController;

  abortCurrentRun(reason?: string): boolean {
    const controller = this.currentAbortController;
    if (!controller || controller.signal.aborted) {
      return false;
    }

    controller.abort(reason);
    return true;
  }

  async runTask(session: AgentSession, question: string, options?: AgentRunOptions) {
    session.prepareUserTurn(question);

    const model = this.createContextAwareModel((context) => {
      session.mergeExtractedContext(context);
    });

    const abortController = this.createAbortController();
    this.currentAbortController = abortController;

    try {
      return await this.modelExecutor.generate({
        model,
        messages: session.getMessages(),
        modelParams: this.modelParams,
        abortSignal: abortController.signal,
        tools: this.createToolRegistryForRun(options),
        stopWhen: stepCountIs(this.maxSteps),
        onOutputMessage: options?.onOutputMessage,
      });
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  runTaskStream(session: AgentSession, question: string, options?: AgentRunOptions) {
    session.prepareUserTurn(question);

    const model = this.createContextAwareModel((context) => {
      session.mergeExtractedContext(context);
    });

    const abortController = this.createAbortController();
    this.currentAbortController = abortController;

    const stream = this.modelExecutor.stream({
      model,
      messages: session.getMessages(),
      modelParams: this.modelParams,
      abortSignal: abortController.signal,
      tools: this.createToolRegistryForRun(options),
      stopWhen: stepCountIs(this.maxSteps),
      onOutputMessage: options?.onOutputMessage,
    });

    const originalTextStream = stream.textStream;
    const self = this;

    async function* wrappedTextStream() {
      try {
        for await (const part of originalTextStream) {
          yield part;
        }
      } finally {
        if (self.currentAbortController === abortController) {
          self.currentAbortController = null;
        }
      }
    }

    return {
      ...stream,
      textStream: wrappedTextStream(),
    };
  }

  private createToolRegistryForRun(options?: AgentRunOptions): ToolDefinitionMap {
    return this.createToolRegistry({
      context: {
        ...this.baseToolContext,
        onOutputMessage: options?.onOutputMessage,
      },
      mcpTools: this.mcpTools,
    });
  }

  private createContextAwareModel(
    onExtractContext: (context: Partial<AgentContext>) => void,
  ): LanguageModelV3 {
    return wrapLanguageModel({
      model: this.model,
      middleware: [this.createExtractContextMiddleware(onExtractContext)],
    });
  }
}
