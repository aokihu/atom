import {
  stepCountIs,
  wrapLanguageModel,
} from "ai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";

import { extractContextMiddleware } from "../../utils/ai-sdk/middlewares/extractContextMiddleware";
import {
  DEFAULT_AGENT_EXECUTION_CONFIG,
  type AgentContext,
  type AgentExecutionConfig,
  type AgentIntentDetectorMode,
  type AgentModelParams,
  type ResolvedAgentExecutionConfig,
} from "../../../types/agent";
import type { TaskExecutionStopReason } from "../../../types/task";
import {
  createToolRegistry,
  ToolBudgetExceededError,
  type ToolDefinitionMap,
  type ToolBudgetController,
  type ToolExecutionContext,
} from "../tools";
import { AgentSession } from "../session/agent_session";
import { AISDKModelExecutor } from "./model_executor";
import { planContextBudget } from "./context_budget";
import { runIntentGuard } from "./intent_guard";
import {
  emitOutputMessage,
  type AgentOutputMessageSink,
} from "./output_messages";

export type AgentRunStopReason =
  | "completed"
  | TaskExecutionStopReason
  | "cancelled";

export type AgentRunDetailedResult = {
  text: string;
  finishReason: string;
  stepCount: number;
  totalModelSteps: number;
  totalToolCalls: number;
  segmentCount: number;
  completed: boolean;
  stopReason: AgentRunStopReason;
  tokenUsage?: {
    source: "ai-sdk";
    updated_at: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    reasoning_tokens: number;
    cached_input_tokens: number;
    cumulative_total_tokens: number;
  };
};

export class AgentControlledStopError extends Error {
  readonly stopReason: TaskExecutionStopReason;
  readonly details: Pick<
    AgentRunDetailedResult,
    "segmentCount" | "totalToolCalls" | "totalModelSteps" | "finishReason"
  >;

  constructor(result: AgentRunDetailedResult & { completed: false; stopReason: TaskExecutionStopReason }) {
    super(`Task not completed: ${result.stopReason}`);
    this.name = "AgentControlledStopError";
    this.stopReason = result.stopReason;
    this.details = {
      segmentCount: result.segmentCount,
      totalToolCalls: result.totalToolCalls,
      totalModelSteps: result.totalModelSteps,
      finishReason: result.finishReason,
    };
  }
}

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
  executionConfig?: AgentExecutionConfig;
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
  private readonly executionConfig: ResolvedAgentExecutionConfig;

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
    this.executionConfig = resolveExecutionConfig({
      config: deps.executionConfig,
      legacyMaxSteps: deps.maxSteps,
    });
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
    const result = await this.runTaskDetailed(session, question, options);
    if (!result.completed) {
      throw new AgentControlledStopError(result as AgentRunDetailedResult & {
        completed: false;
        stopReason: TaskExecutionStopReason;
      });
    }
    return result.text;
  }

  async runTaskDetailed(
    session: AgentSession,
    question: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunDetailedResult> {
    const toolBudget = new TaskToolBudget(this.executionConfig.maxToolCallsPerTask);
    let segmentCount = 0;
    let totalModelSteps = 0;
    let continuationRuns = 0;
    let finalText = "";
    let finalFinishReason = "unknown";
    let latestTokenUsage: AgentRunDetailedResult["tokenUsage"] | undefined;
    let cumulativeTotalTokens = 0;

    const model = this.createContextAwareModel((context) => {
      session.mergeExtractedContext(context);
    });

    const intentResult = await runIntentGuard({
      model: this.model,
      input: question,
      config: this.executionConfig.intentGuard,
    });
    if (intentResult.decision.action === "fail") {
      const result: AgentRunDetailedResult = {
        text: "",
        finishReason: "intent_guard_blocked",
        stepCount: 0,
        totalModelSteps: 0,
        totalToolCalls: 0,
        segmentCount: 0,
        completed: false,
        stopReason: "intent_guard_blocked",
      };
      this.emitTerminalMessages(options, result);
      return result;
    }
    const guardedQuestion =
      intentResult.decision.action === "soft_fail"
        ? [
            "[Intent Guard Notice] Prioritize safe, least-privilege execution.",
            question,
          ].join("\n")
        : question;

    const abortController = this.createAbortController();
    this.currentAbortController = abortController;

    try {
      while (true) {
        const nextSegmentIndex = segmentCount + 1;
        this.writeExecutionBudgetContext(session, {
          segmentIndex: nextSegmentIndex,
          continuationRuns,
          totalModelSteps,
          toolBudget,
        });

        const segmentQuestion =
          segmentCount === 0
            ? guardedQuestion
            : this.buildContinuationPrompt({
                segmentIndex: nextSegmentIndex,
                continuationRuns,
                totalModelSteps,
                toolBudget,
              });

        const budgetPlan = this.executionConfig.contextBudget.enabled
          ? planContextBudget({
              baseMessages: session.getMessagesSnapshot(),
              context: session.getContextSnapshot(),
              userInput: segmentQuestion,
              executionBudget: this.executionConfig.contextBudget,
              contextWindowTokens: this.executionConfig.contextBudget.contextWindowTokens,
              requestedOutputTokens:
                this.modelParams?.maxOutputTokens ??
                this.executionConfig.contextBudget.reserveOutputTokensMax,
            })
          : {
              stop: false,
              outputLimitTokens:
                this.modelParams?.maxOutputTokens ??
                this.executionConfig.contextBudget.reserveOutputTokensMax,
              projectionOptions: undefined,
              rewrittenInput: segmentQuestion,
              budget: undefined,
            };

        if (budgetPlan.budget) {
          session.updateRuntimeDiagnostics({
            budget: budgetPlan.budget,
          });
        }

        if (budgetPlan.stop) {
          const result: AgentRunDetailedResult = {
            text: finalText,
            finishReason: "context_budget_exhausted",
            stepCount: 0,
            totalModelSteps,
            totalToolCalls: toolBudget.usedCount,
            segmentCount: Math.max(segmentCount, nextSegmentIndex),
            completed: false,
            stopReason: "context_budget_exhausted",
            tokenUsage: latestTokenUsage,
          };
          this.emitTerminalMessages(options, result);
          return result;
        }

        const effectiveQuestion = budgetPlan.rewrittenInput ?? segmentQuestion;
        if (segmentCount === 0) {
          session.prepareUserTurn(effectiveQuestion, {
            projectionOptions: budgetPlan.projectionOptions,
          });
        } else {
          session.prepareInternalContinuationTurn(
            effectiveQuestion,
            {
              advanceRound: !this.executionConfig.continueWithoutAdvancingContextRound,
              projectionOptions: budgetPlan.projectionOptions,
            },
          );
        }

        let segmentResult;
        const segmentModelParams = {
          ...(this.modelParams ?? {}),
          maxOutputTokens: budgetPlan.outputLimitTokens,
        };
        try {
          segmentResult = await this.modelExecutor.generate({
            model,
            messages: session.getMessages(),
            modelParams: segmentModelParams,
            abortSignal: abortController.signal,
            tools: this.createToolRegistryForRun(options, { toolBudget }),
            stopWhen: stepCountIs(this.executionConfig.maxModelStepsPerRun),
            onOutputMessage: options?.onOutputMessage,
            emitFinalAssistantText: false,
            emitTaskFinishMessage: false,
          });
        } catch (error) {
          if (error instanceof ToolBudgetExceededError) {
            this.writeExecutionBudgetContext(session, {
              segmentIndex: nextSegmentIndex,
              continuationRuns,
              totalModelSteps,
              toolBudget,
            });
            const result: AgentRunDetailedResult = {
              text: finalText,
              finishReason: "tool_budget_exhausted",
              stepCount: 0,
              totalModelSteps,
              totalToolCalls: toolBudget.usedCount,
              segmentCount: Math.max(segmentCount, nextSegmentIndex),
              completed: false,
              stopReason: "tool_budget_exhausted",
              tokenUsage: latestTokenUsage,
            };
            this.emitTerminalMessages(options, result);
            return result;
          }
          throw error;
        }

        segmentCount += 1;
        totalModelSteps += segmentResult.stepCount;
        finalText = segmentResult.text;
        finalFinishReason = segmentResult.finishReason;
        if (segmentResult.tokenUsage) {
          const inputTokens = segmentResult.tokenUsage.inputTokens ?? 0;
          const outputTokens = segmentResult.tokenUsage.outputTokens ?? 0;
          const totalTokens = segmentResult.tokenUsage.totalTokens ?? inputTokens + outputTokens;
          cumulativeTotalTokens += totalTokens;
          latestTokenUsage = {
            source: "ai-sdk",
            updated_at: Date.now(),
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: totalTokens,
            reasoning_tokens: segmentResult.tokenUsage.reasoningTokens ?? 0,
            cached_input_tokens: segmentResult.tokenUsage.cachedInputTokens ?? 0,
            cumulative_total_tokens: cumulativeTotalTokens,
          };
          session.updateRuntimeDiagnostics({
            token_usage: latestTokenUsage,
          });
        }

        this.writeExecutionBudgetContext(session, {
          segmentIndex: segmentCount,
          continuationRuns,
          totalModelSteps,
          toolBudget,
        });

        const decision = classifySegmentOutcome({
          finishReason: finalFinishReason,
          segmentStepCount: segmentResult.stepCount,
          config: this.executionConfig,
          totalModelSteps,
          continuationRuns,
        });

        if (decision.kind === "completed") {
          const result: AgentRunDetailedResult = {
            text: finalText,
            finishReason: finalFinishReason,
            stepCount: segmentResult.stepCount,
            totalModelSteps,
            totalToolCalls: toolBudget.usedCount,
            segmentCount,
            completed: true,
            stopReason: "completed",
            tokenUsage: latestTokenUsage,
          };
          this.emitTerminalMessages(options, result);
          return result;
        }

        if (decision.kind === "stop") {
          const result: AgentRunDetailedResult = {
            text: finalText,
            finishReason: finalFinishReason,
            stepCount: segmentResult.stepCount,
            totalModelSteps,
            totalToolCalls: toolBudget.usedCount,
            segmentCount,
            completed: false,
            stopReason: decision.stopReason,
            tokenUsage: latestTokenUsage,
          };
          this.emitTerminalMessages(options, result);
          return result;
        }

        continuationRuns += 1;
      }
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
      stopWhen: stepCountIs(this.executionConfig.maxModelStepsPerRun),
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

  private createToolRegistryForRun(
    options?: AgentRunOptions,
    extras?: { toolBudget?: ToolBudgetController },
  ): ToolDefinitionMap {
    return this.createToolRegistry({
      context: {
        ...this.baseToolContext,
        onOutputMessage: options?.onOutputMessage,
        toolBudget: extras?.toolBudget,
      },
      mcpTools: this.mcpTools,
    });
  }

  private emitTerminalMessages(options: AgentRunOptions | undefined, result: AgentRunDetailedResult) {
    if (result.completed && result.text) {
      emitOutputMessage(options?.onOutputMessage, {
        category: "assistant",
        type: "assistant.text",
        text: result.text,
        final: true,
      });
    }

    emitOutputMessage(options?.onOutputMessage, {
      category: "other",
      type: "task.finish",
      finishReason: result.completed ? result.finishReason : result.stopReason,
      text: result.completed
        ? `Task finished (${result.finishReason})`
        : `Task stopped (${result.stopReason})`,
    });
  }

  private writeExecutionBudgetContext(
    session: AgentSession,
    state: {
      segmentIndex: number;
      continuationRuns: number;
      totalModelSteps: number;
      toolBudget: TaskToolBudget;
    },
  ) {
    session.mergeExtractedContext({
      active_task_meta: {
        execution: {
          segment_index: state.segmentIndex,
          auto_continue_enabled: this.executionConfig.autoContinueOnStepLimit,
          tool_calls: {
            limit: state.toolBudget.limit,
            used: state.toolBudget.usedCount,
            remaining: state.toolBudget.remainingCount,
          },
          model_steps: {
            per_run_limit: this.executionConfig.maxModelStepsPerRun,
            task_limit: this.executionConfig.maxModelStepsPerTask,
            used: state.totalModelSteps,
            remaining: Math.max(
              0,
              this.executionConfig.maxModelStepsPerTask - state.totalModelSteps,
            ),
          },
          continuations: {
            used: state.continuationRuns,
            limit: this.executionConfig.maxContinuationRuns,
          },
        },
      },
    } as Partial<AgentContext>);
  }

  private buildContinuationPrompt(state: {
    segmentIndex: number;
    continuationRuns: number;
    totalModelSteps: number;
    toolBudget: TaskToolBudget;
  }): string {
    const remainingModelSteps = Math.max(
      0,
      this.executionConfig.maxModelStepsPerTask - state.totalModelSteps,
    );
    return [
      "继续当前未完成任务。",
      "请结合当前上下文中的 active_task、memory.working 与 active_task_meta.execution 继续推进。",
      "优先使用工具完成剩余步骤，不要重复已完成的工作。",
      "如果预算接近上限，优先完成关键路径并给出最小下一步。",
      `当前分段: ${state.segmentIndex}`,
      `工具预算剩余: ${state.toolBudget.remainingCount}/${state.toolBudget.limit}`,
      `模型步数预算剩余: ${remainingModelSteps}/${this.executionConfig.maxModelStepsPerTask}`,
      `已使用续跑次数: ${state.continuationRuns}/${this.executionConfig.maxContinuationRuns}`,
    ].join("\n");
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

const resolveExecutionConfig = (args: {
  config?: AgentExecutionConfig;
  legacyMaxSteps?: number;
}): ResolvedAgentExecutionConfig => {
  const config = args.config ?? {};
  const legacyMaxSteps = args.legacyMaxSteps;
  const detector = config.intentGuard?.detector;
  const resolvedDetector: AgentIntentDetectorMode =
    typeof detector === "string"
      ? detector
      : detector?.mode ?? DEFAULT_AGENT_EXECUTION_CONFIG.intentGuard.detector;
  const detectorTimeoutMs =
    typeof detector === "object" && detector !== null && typeof detector.timeoutMs === "number"
      ? Math.max(1, Math.floor(detector.timeoutMs))
      : DEFAULT_AGENT_EXECUTION_CONFIG.intentGuard.detectorTimeoutMs;
  const detectorModelMaxOutputTokens =
    typeof detector === "object" &&
    detector !== null &&
    typeof detector.modelMaxOutputTokens === "number"
      ? Math.max(1, Math.floor(detector.modelMaxOutputTokens))
      : DEFAULT_AGENT_EXECUTION_CONFIG.intentGuard.detectorModelMaxOutputTokens;

  return {
    ...DEFAULT_AGENT_EXECUTION_CONFIG,
    ...config,
    contextV2: {
      ...DEFAULT_AGENT_EXECUTION_CONFIG.contextV2,
      ...(config.contextV2 ?? {}),
    },
    inputPolicy: {
      ...DEFAULT_AGENT_EXECUTION_CONFIG.inputPolicy,
      ...(config.inputPolicy ?? {}),
    },
    contextBudget: {
      ...DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget,
      ...(config.contextBudget ?? {}),
      outputStepDownTokens:
        config.contextBudget?.outputStepDownTokens?.length
          ? Array.from(
              new Set(
                config.contextBudget.outputStepDownTokens
                  .map((item) => Math.max(1, Math.floor(item)))
                  .filter((item) => Number.isFinite(item)),
              ),
            )
          : DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget.outputStepDownTokens,
    },
    overflowPolicy: {
      ...DEFAULT_AGENT_EXECUTION_CONFIG.overflowPolicy,
      ...(config.overflowPolicy ?? {}),
    },
    intentGuard: {
      ...DEFAULT_AGENT_EXECUTION_CONFIG.intentGuard,
      ...(config.intentGuard ?? {}),
      detector: resolvedDetector,
      detectorTimeoutMs,
      detectorModelMaxOutputTokens,
    },
    maxModelStepsPerRun:
      legacyMaxSteps ?? config.maxModelStepsPerRun ?? DEFAULT_AGENT_EXECUTION_CONFIG.maxModelStepsPerRun,
  };
};

class TaskToolBudget implements ToolBudgetController {
  readonly limit: number;
  private used = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get usedCount() {
    return this.used;
  }

  get remainingCount() {
    return Math.max(0, this.limit - this.used);
  }

  tryConsume(toolName: string) {
    if (this.used >= this.limit) {
      return {
        ok: false as const,
        used: this.used,
        remaining: this.remainingCount,
        limit: this.limit,
        toolName,
      };
    }

    this.used += 1;
    return {
      ok: true as const,
      used: this.used,
      remaining: this.remainingCount,
      limit: this.limit,
      toolName,
    };
  }
}

type SegmentOutcomeDecision =
  | { kind: "completed" }
  | { kind: "auto_continue" }
  | { kind: "stop"; stopReason: TaskExecutionStopReason };

const didHitPerRunStepLimit = (args: {
  finishReason: string;
  segmentStepCount: number;
  perRunStepLimit: number;
}): boolean => {
  if (args.segmentStepCount >= args.perRunStepLimit) {
    return true;
  }

  const normalized = args.finishReason.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  // Future-proofing for providers that report explicit length/step-stop reasons.
  return /\b(length|step|steps|max|limit)\b/.test(normalized) &&
    args.segmentStepCount === args.perRunStepLimit;
};

const shouldAutoContinue = (args: {
  hitPerRunStepLimit: boolean;
  autoContinueOnStepLimit: boolean;
  continuationRuns: number;
  maxContinuationRuns: number;
}): boolean => {
  if (!args.hitPerRunStepLimit) return false;
  if (!args.autoContinueOnStepLimit) return false;
  return args.continuationRuns < args.maxContinuationRuns;
};

const classifySegmentOutcome = (args: {
  finishReason: string;
  segmentStepCount: number;
  config: ResolvedAgentExecutionConfig;
  totalModelSteps: number;
  continuationRuns: number;
}): SegmentOutcomeDecision => {
  if (args.totalModelSteps >= args.config.maxModelStepsPerTask) {
    return { kind: "stop", stopReason: "model_step_budget_exhausted" };
  }

  const hitPerRunStepLimit = didHitPerRunStepLimit({
    finishReason: args.finishReason,
    segmentStepCount: args.segmentStepCount,
    perRunStepLimit: args.config.maxModelStepsPerRun,
  });

  if (!hitPerRunStepLimit) {
    return { kind: "completed" };
  }

  if (
    shouldAutoContinue({
      hitPerRunStepLimit,
      autoContinueOnStepLimit: args.config.autoContinueOnStepLimit,
      continuationRuns: args.continuationRuns,
      maxContinuationRuns: args.config.maxContinuationRuns,
    })
  ) {
    return { kind: "auto_continue" };
  }

  if (!args.config.autoContinueOnStepLimit) {
    return { kind: "stop", stopReason: "step_limit_segment_continue" };
  }

  return { kind: "stop", stopReason: "continuation_limit_reached" };
};

export const __agentRunnerInternals = {
  didHitPerRunStepLimit,
  shouldAutoContinue,
  classifySegmentOutcome,
};
