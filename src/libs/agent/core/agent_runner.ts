import {
  stepCountIs,
  wrapLanguageModel,
} from "ai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";

import { extractContextMiddleware } from "../../utils/ai-sdk/middlewares/extractContextMiddleware";
import {
  AGENT_INTENT_GUARD_INTENT_KINDS,
  DEFAULT_AGENT_EXECUTION_CONFIG,
  type AgentContext,
  type AgentContextRuntime,
  type AgentExecutionConfig,
  type AgentModelParams,
  type AgentIntentGuardIntentKind,
  type AgentIntentGuardIntentPolicyConfig,
  type ResolvedAgentIntentGuardConfig,
  type ResolvedAgentIntentGuardIntentPolicyConfig,
  type ResolvedAgentExecutionConfig,
} from "../../../types/agent";
import type { TaskExecutionStopReason } from "../../../types/task";
import {
  BUILTIN_TOOL_NAMES,
  createToolRegistry,
  ToolBudgetExceededError,
  ToolPolicyBlockedError,
  type ToolDefinitionMap,
  type ToolBudgetController,
  type ToolExecutionSettledEvent,
  type ToolExecutionContext,
} from "../tools";
import { readTodoProgressStateForWorkspace } from "../tools/todo_store";
import { AgentSession } from "../session/agent_session";
import { AISDKModelExecutor } from "./model_executor";
import { ContextBudgetOrchestrator } from "./context_budget";
import {
  emitOutputMessage,
  type AgentOutputMessageSink,
} from "./output_messages";
import type {
  PersistentMemoryAfterTaskMeta,
  PersistentMemoryHooks,
} from "../memory/persistent_types";
import {
  createTaskIntentGuard,
  detectTaskIntent,
  type TaskIntent,
  type TaskIntentGuard,
} from "./intent_guard";

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
  persistentMemoryHooks?: PersistentMemoryHooks;
  detectTaskIntent?: (args: {
    model: LanguageModelV3;
    question: string;
    config: ResolvedAgentIntentGuardConfig;
    abortSignal?: AbortSignal;
  }) => Promise<TaskIntent>;
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
  private readonly contextBudgetOrchestrator: ContextBudgetOrchestrator;
  private readonly persistentMemoryHooks?: PersistentMemoryHooks;
  private readonly detectTaskIntent: (args: {
    model: LanguageModelV3;
    question: string;
    config: ResolvedAgentIntentGuardConfig;
    abortSignal?: AbortSignal;
  }) => Promise<TaskIntent>;

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
    this.contextBudgetOrchestrator = new ContextBudgetOrchestrator(this.executionConfig.contextBudget);
    this.persistentMemoryHooks = deps.persistentMemoryHooks;
    this.detectTaskIntent = deps.detectTaskIntent ?? detectTaskIntent;
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
    let intentGuard: TaskIntentGuard | null = null;
    let currentQuestion = question;
    let latestBudgetContext: NonNullable<AgentContextRuntime["budget"]> | null = null;

    const model = this.createContextAwareModel((context) => {
      session.mergeModelExtractedContext(context);
    });

    const abortController = this.createAbortController();
    this.currentAbortController = abortController;
    let persistentAfterTaskMeta: PersistentMemoryAfterTaskMeta | undefined;

    try {
      await this.invokePersistentMemoryBeforeTask(session, question);
      intentGuard = await this.createTaskIntentGuardForRun(question, model, abortController.signal);
      const preflightFailure = intentGuard?.getPreflightFailure();
      if (preflightFailure) {
        const result: AgentRunDetailedResult = {
          text: preflightFailure.message,
          finishReason: preflightFailure.stopReason,
          stepCount: 0,
          totalModelSteps,
          totalToolCalls: toolBudget.usedCount,
          segmentCount,
          completed: false,
          stopReason: preflightFailure.stopReason,
        };
        persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
        this.emitTerminalMessages(options, result);
        return result;
      }

      while (true) {
        const nextSegmentIndex = segmentCount + 1;
        this.refreshTodoProgressContext(session);
        let runModelParams = this.modelParams;

        let currentTurnPrompt: string;
        if (segmentCount === 0) {
          currentTurnPrompt = currentQuestion;
          session.prepareUserTurn(currentTurnPrompt);
        } else {
          currentTurnPrompt = this.buildContinuationPrompt({
            segmentIndex: nextSegmentIndex,
            continuationRuns,
            totalModelSteps,
            toolBudget,
          });
          session.prepareInternalContinuationTurn(
            currentTurnPrompt,
            {
              advanceRound: !this.executionConfig.continueWithoutAdvancingContextRound,
            },
          );
        }

        const budgetResult = this.contextBudgetOrchestrator.apply({
          session,
          question: currentTurnPrompt,
          modelParams: runModelParams,
        });
        runModelParams = budgetResult.modelParams;
        latestBudgetContext = budgetResult.budget;
        session.updateRuntimeBudget(latestBudgetContext);
        if (segmentCount === 0) {
          currentQuestion = budgetResult.question;
        }

        this.writeExecutionBudgetContext(session, {
          segmentIndex: nextSegmentIndex,
          continuationRuns,
          totalModelSteps,
          toolBudget,
        });

        if (budgetResult.exhausted) {
          const result: AgentRunDetailedResult = {
            text: "Task not completed: context budget exhausted before model execution.",
            finishReason: "context_budget_exhausted",
            stepCount: 0,
            totalModelSteps,
            totalToolCalls: toolBudget.usedCount,
            segmentCount: Math.max(segmentCount, nextSegmentIndex),
            completed: false,
            stopReason: "context_budget_exhausted",
          };
          persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
          this.emitTerminalMessages(options, result);
          return result;
        }

        let segmentResult;
        try {
          segmentResult = await this.modelExecutor.generate({
            model,
            messages: session.getMessages(),
            modelParams: runModelParams,
            abortSignal: abortController.signal,
            tools: this.createToolRegistryForRun(session, options, { toolBudget, intentGuard }),
            stopWhen: stepCountIs(this.executionConfig.maxModelStepsPerRun),
            onOutputMessage: options?.onOutputMessage,
            onUsage: (usage) => {
              session.recordRuntimeTokenUsageFromSDK(usage);
            },
            emitFinalAssistantText: false,
            emitTaskFinishMessage: false,
          });
        } catch (error) {
          if (error instanceof ToolBudgetExceededError) {
            this.refreshTodoProgressContext(session);
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
            };
            persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
            this.emitTerminalMessages(options, result);
            return result;
          }

          if (error instanceof ToolPolicyBlockedError) {
            this.refreshTodoProgressContext(session);
            this.writeExecutionBudgetContext(session, {
              segmentIndex: nextSegmentIndex,
              continuationRuns,
              totalModelSteps,
              toolBudget,
            });
            const result: AgentRunDetailedResult = {
              text: error.message,
              finishReason: error.stopReason,
              stepCount: 0,
              totalModelSteps,
              totalToolCalls: toolBudget.usedCount,
              segmentCount: Math.max(segmentCount, nextSegmentIndex),
              completed: false,
              stopReason: error.stopReason,
            };
            persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
            this.emitTerminalMessages(options, result);
            return result;
          }
          throw error;
        }

        segmentCount += 1;
        totalModelSteps += segmentResult.stepCount;
        finalText = segmentResult.text;
        finalFinishReason = segmentResult.finishReason;
        this.refreshTodoProgressContext(session);

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
          const intentCompletionFailure = intentGuard?.getCompletionFailure();
          if (intentCompletionFailure) {
            const result: AgentRunDetailedResult = {
              text: intentCompletionFailure.message,
              finishReason: intentCompletionFailure.stopReason,
              stepCount: segmentResult.stepCount,
              totalModelSteps,
              totalToolCalls: toolBudget.usedCount,
              segmentCount,
              completed: false,
              stopReason: intentCompletionFailure.stopReason,
            };
            persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
            this.emitTerminalMessages(options, result);
            return result;
          }

          const result: AgentRunDetailedResult = {
            text: finalText,
            finishReason: finalFinishReason,
            stepCount: segmentResult.stepCount,
            totalModelSteps,
            totalToolCalls: toolBudget.usedCount,
            segmentCount,
            completed: true,
            stopReason: "completed",
          };
          persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
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
          };
          persistentAfterTaskMeta = this.toPersistentAfterTaskMeta(result, "detailed");
          this.emitTerminalMessages(options, result);
          return result;
        }

        continuationRuns += 1;
      }
    } catch (error) {
      persistentAfterTaskMeta = persistentAfterTaskMeta ?? {
        completed: false,
        mode: "detailed",
      };
      throw error;
    } finally {
      session.updateRuntimeBudget(latestBudgetContext);
      await this.invokePersistentMemoryAfterTask(session, persistentAfterTaskMeta);
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  async runTaskStream(session: AgentSession, question: string, options?: AgentRunOptions) {
    await this.invokePersistentMemoryBeforeTask(session, question);
    this.refreshTodoProgressContext(session);
    session.prepareUserTurn(question);
    let runModelParams = this.modelParams;
    const budgetResult = this.contextBudgetOrchestrator.apply({
      session,
      question,
      modelParams: runModelParams,
    });
    runModelParams = budgetResult.modelParams;
    session.updateRuntimeBudget(budgetResult.budget);
    if (budgetResult.exhausted) {
      await this.invokePersistentMemoryAfterTask(session, {
        completed: false,
        mode: "stream",
        stopReason: "context_budget_exhausted",
      });
      throw new ToolPolicyBlockedError({
        toolName: "context_budget",
        reason: "Task not completed: context budget exhausted before model execution.",
        stopReason: "context_budget_exhausted",
      });
    }

    const model = this.createContextAwareModel((context) => {
      session.mergeModelExtractedContext(context);
    });

    const abortController = this.createAbortController();
    this.currentAbortController = abortController;
    const intentGuard = await this.createTaskIntentGuardForRun(question, model, abortController.signal);
    const preflightFailure = intentGuard?.getPreflightFailure();
    if (preflightFailure) {
      await this.invokePersistentMemoryAfterTask(session, {
        completed: false,
        mode: "stream",
        stopReason: preflightFailure.stopReason,
      });
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      throw new ToolPolicyBlockedError({
        toolName: "intent_guard",
        reason: preflightFailure.message,
        stopReason: preflightFailure.stopReason,
      });
    }

    const stream = this.modelExecutor.stream({
      model,
      messages: session.getMessages(),
      modelParams: runModelParams,
      abortSignal: abortController.signal,
      tools: this.createToolRegistryForRun(session, options, { intentGuard }),
      stopWhen: stepCountIs(this.executionConfig.maxModelStepsPerRun),
      onOutputMessage: options?.onOutputMessage,
      onUsage: (usage) => {
        session.recordRuntimeTokenUsageFromSDK(usage);
      },
    });

    const originalTextStream = stream.textStream;
    const self = this;

    async function* wrappedTextStream() {
      try {
        for await (const part of originalTextStream) {
          yield part;
        }
      } finally {
        self.refreshTodoProgressContext(session);
        await self.invokePersistentMemoryAfterTask(session, {
          mode: "stream",
        });
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
    session: AgentSession,
    options?: AgentRunOptions,
    extras?: { toolBudget?: ToolBudgetController; intentGuard?: TaskIntentGuard | null },
  ): ToolDefinitionMap {
    return this.createToolRegistry({
      context: {
        ...this.baseToolContext,
        onOutputMessage: options?.onOutputMessage,
        toolBudget: extras?.toolBudget,
        beforeToolExecution: (event) => {
          const guard = extras?.intentGuard;
          if (!guard) {
            return { allow: true };
          }

          return guard.beforeToolExecution(event.toolName);
        },
        toolOutputMessageSource: "sdk_hooks",
        onToolExecutionSettled: async (event) => {
          await this.handleToolExecutionSettledForContext(session, event, extras?.intentGuard ?? null);
        },
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

  private async handleToolExecutionSettledForContext(
    session: AgentSession,
    event: ToolExecutionSettledEvent,
    intentGuard?: TaskIntentGuard | null,
  ) {
    intentGuard?.onToolSettled({
      toolName: event.toolName,
      ok: event.ok,
    });

    if (!event.ok) {
      return;
    }

    if (isTodoToolName(event.toolName)) {
      this.refreshTodoProgressContext(session, {
        todoOverride: getTodoProgressContextFromToolOutput(event.result),
      });
    }

    if (isMemoryToolName(event.toolName)) {
      const contextPatch = getContextPatchFromToolOutput(event.result);
      if (contextPatch) {
        session.mergeSystemContextPatch(contextPatch);
      }
    }
  }

  private refreshTodoProgressContext(
    session: AgentSession,
    options?: { todoOverride?: { summary: string; total: number; step: number } | null },
  ) {
    const workspace = this.baseToolContext.workspace;
    if (typeof workspace !== "string" || workspace.trim() === "") {
      return;
    }

    try {
      const todoState = readTodoProgressStateForWorkspace(workspace);
      const progress = options?.todoOverride ?? todoState.progress;
      const currentTodo = (session.getContextSnapshot().todo ?? {}) as Record<string, unknown>;
      const nextTodoPatch: Record<string, unknown> = {
        summary: progress.summary,
        total: progress.total,
        step: progress.step,
      };

      const reconciledCursor = reconcileTodoCursor(currentTodo.cursor, todoState.items);
      if (reconciledCursor.kind === "clear") {
        nextTodoPatch.cursor = null;
      }

      session.mergeSystemContextPatch({ todo: nextTodoPatch } as Partial<AgentContext>);
    } catch {
      // Best-effort context enrichment; do not fail task execution on TODO progress read errors.
    }
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
    session.mergeSystemContextPatch({
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

  private getAvailableToolNamesForIntentGuard(): string[] {
    const names = new Set<string>();
    for (const name of BUILTIN_TOOL_NAMES) {
      names.add(name);
    }
    for (const name of Object.keys(this.mcpTools ?? {})) {
      names.add(name);
    }
    return [...names];
  }

  private async createTaskIntentGuardForRun(
    question: string,
    model: LanguageModelV3,
    abortSignal?: AbortSignal,
  ): Promise<TaskIntentGuard | null> {
    const config = this.executionConfig.intentGuard;
    if (!config.enabled) {
      return null;
    }

    const intent = await this.detectTaskIntent({
      model,
      question,
      config,
      abortSignal,
    });

    return createTaskIntentGuard({
      intent,
      config,
      availableToolNames: this.getAvailableToolNamesForIntentGuard(),
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

  private toPersistentAfterTaskMeta(
    result: AgentRunDetailedResult,
    mode: "detailed" | "stream",
  ): PersistentMemoryAfterTaskMeta {
    return {
      completed: result.completed,
      mode,
      ...(result.completed
        ? { finishReason: result.finishReason }
        : { stopReason: result.stopReason }),
    };
  }

  private async invokePersistentMemoryBeforeTask(session: AgentSession, question: string) {
    if (!this.persistentMemoryHooks) return;

    try {
      await this.persistentMemoryHooks.beforeTask(session, question);
    } catch (error) {
      console.warn(
        `[memory] beforeTask hook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async invokePersistentMemoryAfterTask(
    session: AgentSession,
    meta?: PersistentMemoryAfterTaskMeta,
  ) {
    if (!this.persistentMemoryHooks) return;

    try {
      await this.persistentMemoryHooks.afterTask(session, meta);
    } catch (error) {
      console.warn(
        `[memory] afterTask hook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTodoToolName = (toolName: string) => /^todo_/.test(toolName);
const isMemoryToolName = (toolName: string) => /^memory_/.test(toolName);

const getTodoProgressContextFromToolOutput = (
  value: unknown,
): { summary: string; total: number; step: number } | null => {
  if (!isRecord(value)) return null;
  const todo = value.todo;
  if (!isRecord(todo)) return null;
  const summary = typeof todo.summary === "string" ? todo.summary : null;
  const total =
    typeof todo.total === "number" && Number.isFinite(todo.total) ? Math.max(0, Math.trunc(todo.total)) : null;
  const step =
    typeof todo.step === "number" && Number.isFinite(todo.step) ? Math.max(0, Math.trunc(todo.step)) : null;
  if (summary === null || total === null || step === null) return null;
  return {
    summary,
    total,
    step: Math.min(step, total),
  };
};

const getContextPatchFromToolOutput = (value: unknown): Partial<AgentContext> | null => {
  if (!isRecord(value)) return null;
  const patch = value.context_patch;
  if (!isRecord(patch)) return null;
  return patch as Partial<AgentContext>;
};

type TodoCursorReconcileResult =
  | { kind: "keep" }
  | { kind: "clear"; reason: "target_missing" | "consumed_complete" | "consumed_reopen" | "consumed_remove" };

const reconcileTodoCursor = (
  rawCursor: unknown,
  items: ReadonlyArray<{ id: number; status: "open" | "done" }>,
): TodoCursorReconcileResult => {
  if (!isRecord(rawCursor)) return { kind: "keep" };
  const next = typeof rawCursor.next === "string" ? rawCursor.next : null;
  const targetId =
    typeof rawCursor.targetId === "number" && Number.isFinite(rawCursor.targetId)
      ? Math.trunc(rawCursor.targetId)
      : rawCursor.targetId === null
        ? null
        : undefined;

  if (next === null || targetId === undefined) {
    return { kind: "keep" };
  }

  if (targetId === null) {
    return { kind: "keep" };
  }

  const target = items.find((item) => item.id === targetId);
  if (!target) {
    if (next === "todo_remove") {
      return { kind: "clear", reason: "consumed_remove" };
    }
    return { kind: "clear", reason: "target_missing" };
  }

  if (next === "todo_complete" && target.status === "done") {
    return { kind: "clear", reason: "consumed_complete" };
  }

  if (next === "todo_reopen" && target.status === "open") {
    return { kind: "clear", reason: "consumed_reopen" };
  }

  return { kind: "keep" };
};

const resolveExecutionConfig = (args: {
  config?: AgentExecutionConfig;
  legacyMaxSteps?: number;
}): ResolvedAgentExecutionConfig => {
  const config = args.config ?? {};
  const legacyMaxSteps = args.legacyMaxSteps;
  const baseIntentConfig = DEFAULT_AGENT_EXECUTION_CONFIG.intentGuard;
  const userIntentConfig = config.intentGuard ?? {};

  const resolveIntentPolicy = (
    intent: AgentIntentGuardIntentKind,
  ): ResolvedAgentIntentGuardIntentPolicyConfig => {
    const basePolicy = baseIntentConfig.intents[intent];
    const userPolicy = userIntentConfig.intents?.[intent] as AgentIntentGuardIntentPolicyConfig | undefined;
    return {
      ...basePolicy,
      ...(userPolicy ?? {}),
      allowedFamilies: userPolicy?.allowedFamilies ?? basePolicy.allowedFamilies,
      softAllowedFamilies: userPolicy?.softAllowedFamilies ?? basePolicy.softAllowedFamilies,
      requiredSuccessFamilies:
        userPolicy?.requiredSuccessFamilies ?? basePolicy.requiredSuccessFamilies,
      softBlockAfter:
        userPolicy?.softBlockAfter ??
        userIntentConfig.softBlockAfter ??
        basePolicy.softBlockAfter,
    };
  };

  const mergedIntentPolicies = AGENT_INTENT_GUARD_INTENT_KINDS.reduce<
    Record<AgentIntentGuardIntentKind, ResolvedAgentIntentGuardIntentPolicyConfig>
  >((acc, intent) => {
    acc[intent] = resolveIntentPolicy(intent);
    return acc;
  }, {} as Record<AgentIntentGuardIntentKind, ResolvedAgentIntentGuardIntentPolicyConfig>);

  // Backward compatibility: map legacy browser config onto browser_access intent policy.
  if (userIntentConfig.browser) {
    const browserPolicy = mergedIntentPolicies.browser_access;
    mergedIntentPolicies.browser_access = {
      ...browserPolicy,
      noFallback:
        userIntentConfig.browser.noFallback ??
        browserPolicy.noFallback,
      failTaskIfUnmet:
        userIntentConfig.browser.failTaskIfUnmet ??
        browserPolicy.failTaskIfUnmet,
      softAllowedFamilies:
        userIntentConfig.browser.networkAdjacentOnly === false
          ? []
          : browserPolicy.softAllowedFamilies,
    };
  }

  const mergedIntentGuard: ResolvedAgentIntentGuardConfig = {
    ...baseIntentConfig,
    ...(userIntentConfig ?? {}),
    browser: {
      ...baseIntentConfig.browser,
      ...(userIntentConfig.browser ?? {}),
    },
    intents: mergedIntentPolicies,
  };

  const baseInputPolicy = DEFAULT_AGENT_EXECUTION_CONFIG.inputPolicy;
  const userInputPolicy = config.inputPolicy ?? {};
  const mergedInputPolicy = {
    ...baseInputPolicy,
    ...userInputPolicy,
    maxInputTokens: Math.max(
      256,
      Math.min(2_000_000, Math.trunc(userInputPolicy.maxInputTokens ?? baseInputPolicy.maxInputTokens)),
    ),
    summarizeTargetTokens: Math.max(
      128,
      Math.min(
        200_000,
        Math.trunc(userInputPolicy.summarizeTargetTokens ?? baseInputPolicy.summarizeTargetTokens),
      ),
    ),
    spoolDirectory:
      typeof userInputPolicy.spoolDirectory === "string" && userInputPolicy.spoolDirectory.trim() !== ""
        ? userInputPolicy.spoolDirectory.trim()
        : baseInputPolicy.spoolDirectory,
  };

  const baseContextBudget = DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget;
  const userContextBudget = config.contextBudget ?? {};
  const downshiftCandidates = Array.isArray(userContextBudget.outputTokenDownshifts) &&
      userContextBudget.outputTokenDownshifts.length > 0
    ? userContextBudget.outputTokenDownshifts
      .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      .map((item) => Math.max(1, Math.min(200_000, Math.trunc(item))))
    : baseContextBudget.outputTokenDownshifts;
  const normalizedDownshifts = [...new Set(downshiftCandidates)].sort((a, b) => b - a);
  const rawMinMemoryItems = userContextBudget.minMemoryItems ?? {};
  const mergedMinMemoryItems = {
    core: Math.max(
      0,
      Math.min(
        200,
        Math.trunc(
          typeof rawMinMemoryItems.core === "number"
            ? rawMinMemoryItems.core
            : baseContextBudget.minMemoryItems.core,
        ),
      ),
    ),
    working: Math.max(
      0,
      Math.min(
        200,
        Math.trunc(
          typeof rawMinMemoryItems.working === "number"
            ? rawMinMemoryItems.working
            : baseContextBudget.minMemoryItems.working,
        ),
      ),
    ),
    ephemeral: Math.max(
      0,
      Math.min(
        200,
        Math.trunc(
          typeof rawMinMemoryItems.ephemeral === "number"
            ? rawMinMemoryItems.ephemeral
            : baseContextBudget.minMemoryItems.ephemeral,
        ),
      ),
    ),
    longterm: Math.max(
      0,
      Math.min(
        200,
        Math.trunc(
          typeof rawMinMemoryItems.longterm === "number"
            ? rawMinMemoryItems.longterm
            : baseContextBudget.minMemoryItems.longterm,
        ),
      ),
    ),
  };
  const mergedContextBudget = {
    ...baseContextBudget,
    ...userContextBudget,
    contextWindowTokens: Math.max(
      4096,
      Math.min(2_000_000, Math.trunc(userContextBudget.contextWindowTokens ?? baseContextBudget.contextWindowTokens)),
    ),
    reserveOutputTokensCap: Math.max(
      64,
      Math.min(
        200_000,
        Math.trunc(userContextBudget.reserveOutputTokensCap ?? baseContextBudget.reserveOutputTokensCap),
      ),
    ),
    safetyMarginRatio: Math.max(
      0,
      Math.min(0.5, userContextBudget.safetyMarginRatio ?? baseContextBudget.safetyMarginRatio),
    ),
    safetyMarginMinTokens: Math.max(
      0,
      Math.min(
        200_000,
        Math.trunc(userContextBudget.safetyMarginMinTokens ?? baseContextBudget.safetyMarginMinTokens),
      ),
    ),
    outputTokenDownshifts: normalizedDownshifts,
    secondaryCompressTargetTokens: Math.max(
      64,
      Math.min(
        200_000,
        Math.trunc(
          userContextBudget.secondaryCompressTargetTokens ?? baseContextBudget.secondaryCompressTargetTokens,
        ),
      ),
    ),
    memoryTrimStep: Math.max(
      1,
      Math.min(16, Math.trunc(userContextBudget.memoryTrimStep ?? baseContextBudget.memoryTrimStep)),
    ),
    minMemoryItems: mergedMinMemoryItems,
  };

  const baseOverflowPolicy = DEFAULT_AGENT_EXECUTION_CONFIG.overflowPolicy;
  const userOverflowPolicy = config.overflowPolicy ?? {};
  const mergedOverflowPolicy = {
    ...baseOverflowPolicy,
    ...userOverflowPolicy,
    observationWindowMinutes: Math.max(
      1,
      Math.min(
        24 * 60,
        Math.trunc(userOverflowPolicy.observationWindowMinutes ?? baseOverflowPolicy.observationWindowMinutes),
      ),
    ),
    observationMaxSamples: Math.max(
      8,
      Math.min(
        10_000,
        Math.trunc(userOverflowPolicy.observationMaxSamples ?? baseOverflowPolicy.observationMaxSamples),
      ),
    ),
  };

  return {
    ...DEFAULT_AGENT_EXECUTION_CONFIG,
    ...config,
    intentGuard: mergedIntentGuard,
    inputPolicy: mergedInputPolicy,
    contextBudget: mergedContextBudget,
    overflowPolicy: mergedOverflowPolicy,
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
  getTodoProgressContextFromToolOutput,
  getContextPatchFromToolOutput,
  reconcileTodoCursor,
};
