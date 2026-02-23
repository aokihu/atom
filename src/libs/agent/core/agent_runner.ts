import {
  stepCountIs,
  wrapLanguageModel,
} from "ai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";

import { extractContextMiddleware } from "../../utils/ai-sdk/middlewares/extractContextMiddleware";
import type { AgentContext } from "../../../types/agent";
import {
  createToolRegistry,
  type ToolDefinitionMap,
  type ToolExecutionContext,
} from "../tools";
import { AgentSession } from "../session/agent_session";
import { AISDKModelExecutor } from "./model_executor";

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

export class AgentRunner {
  private readonly abortController: AbortController;
  private readonly modelExecutor: AISDKModelExecutor;
  private readonly toolRegistry: ToolDefinitionMap;
  private readonly createExtractContextMiddleware: (
    onExtractContext: (context: Partial<AgentContext>) => void,
  ) => LanguageModelV3Middleware;
  private readonly maxSteps: number;

  constructor(args: {
    model: LanguageModelV3;
    toolContext?: ToolExecutionContext;
    mcpTools?: ToolDefinitionMap;
    dependencies?: AgentDependencies;
  }) {
    this.model = args.model;
    const deps = args.dependencies ?? {};

    this.abortController = (deps.createAbortController ?? (() => new AbortController()))();
    this.modelExecutor = deps.modelExecutor ?? new AISDKModelExecutor();
    this.createExtractContextMiddleware =
      deps.createExtractContextMiddleware ?? extractContextMiddleware;
    this.maxSteps = deps.maxSteps ?? 10;
    this.toolRegistry = (deps.createToolRegistry ?? createToolRegistry)({
      context: args.toolContext ?? {},
      mcpTools: args.mcpTools,
    });
  }

  private readonly model: LanguageModelV3;

  async runTask(session: AgentSession, question: string) {
    session.prepareUserTurn(question);

    const model = this.createContextAwareModel((context) => {
      session.mergeExtractedContext(context);
    });

    return await this.modelExecutor.generate({
      model,
      messages: session.getMessages(),
      abortSignal: this.abortController.signal,
      tools: this.toolRegistry,
      stopWhen: stepCountIs(this.maxSteps),
    });
  }

  runTaskStream(session: AgentSession, question: string) {
    session.prepareUserTurn(question);

    const model = this.createContextAwareModel((context) => {
      session.mergeExtractedContext(context);
    });

    return this.modelExecutor.stream({
      model,
      messages: session.getMessages(),
      abortSignal: this.abortController.signal,
      tools: this.toolRegistry,
      stopWhen: stepCountIs(this.maxSteps),
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
