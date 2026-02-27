import { Agent, type AgentRunDetailedResult } from "../agent/agent";
import { ControlledTaskStopError } from "./errors";
import { PriorityTaskQueue, createTask } from "./queue";

import type { RuntimeGateway } from "../channel/channel";
import type {
  AgentMemoryCompactResponse,
  AgentMemoryDeleteRequest,
  AgentMemoryDeleteResponse,
  AgentMemoryFeedbackRequest,
  AgentMemoryFeedbackResponse,
  AgentMemoryGetRequest,
  AgentMemoryGetResponse,
  AgentMemoryListRecentRequest,
  AgentMemoryListRecentResponse,
  AgentMemorySearchRequest,
  AgentMemorySearchResponse,
  AgentMemoryStatsResponse,
  AgentMemoryTagResolveRequest,
  AgentMemoryTagResolveResponse,
  AgentMemoryUpdateRequest,
  AgentMemoryUpdateResponse,
  AgentMemoryUpsertRequest,
  AgentMemoryUpsertResponse,
  AgentContextResponse,
  AgentMessagesResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ForceAbortResponse,
  QueueStats,
  TaskSnapshot,
  TaskMessagesDelta,
  TaskOutputMessage,
  TaskOutputMessageDraft,
  TaskStatusResponse,
} from "../../types/http";
import type { TaskItem } from "../../types/task";
import type { TaskExecutionStopReason } from "../../types/task";
import { TaskStatus, isTaskExecutionStopReason } from "../../types/task";
import type { PersistentMemoryCoordinator } from "../agent/memory";

const DEFAULT_AGENT_SESSION_ID = "default";
const CONTEXT_OVERFLOW_CANCEL_REASON = "contextoverflow";
const CONTEXT_OVERFLOW_CANCELLED_BY = "system.contextoverflow";

type TaskMessageBuffer = {
  items: TaskOutputMessage[];
  nextSeq: number;
  stepBase: number;
  lastRawCompletedStep: number;
};

const toTaskSnapshot = (task: TaskItem<string, string>): TaskSnapshot => ({
  id: task.id,
  type: task.type,
  priority: task.priority,
  status: task.status,
  input: task.input,
  result: task.result,
  error: task.error ? { ...task.error } : undefined,
  retries: task.retries,
  maxRetries: task.maxRetries,
  createAt: task.createAt,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt,
  parentId: task.parentId,
  metadata:
    task.metadata && typeof task.metadata === "object"
      ? { ...task.metadata }
      : task.metadata,
  cancellable: task.cancellable,
});

export class AgentRuntimeService implements RuntimeGateway {
  readonly startupAt = Date.now();

  private taskQueue: PriorityTaskQueue;
  private taskRegistry = new Map<string, TaskItem<string, string>>();
  private readonly taskMessages = new Map<string, TaskMessageBuffer>();
  private readonly agentSessions = new Map<string, Agent>();
  private readonly persistentMemoryCoordinator?: PersistentMemoryCoordinator;
  private started = false;

  constructor(
    private readonly agent: Agent,
    private readonly logger: Pick<Console, "log"> = console,
    options?: {
      persistentMemoryCoordinator?: PersistentMemoryCoordinator;
    },
  ) {
    this.persistentMemoryCoordinator = options?.persistentMemoryCoordinator;
    this.agentSessions.set(DEFAULT_AGENT_SESSION_ID, this.agent);
    this.taskQueue = new PriorityTaskQueue(
      async (task: TaskItem<string, string>) => {
        this.logger.log("[agent] thinking...");
        this.appendTaskMessage(task.id, {
          category: "other",
          type: "task.status",
          text: "Task running",
        });

        try {
          const result = await this.runAgentTask(task, {
            onOutputMessage: (message) => {
              this.appendTaskMessage(task.id, message);
            },
          });

          if (!result.completed) {
            if (isTaskExecutionStopReason(result.stopReason)) {
              task.metadata = {
                ...(task.metadata && typeof task.metadata === "object" ? task.metadata : {}),
                execution: {
                  completed: false,
                  stopReason: result.stopReason,
                  segmentCount: result.segmentCount,
                  totalToolCalls: result.totalToolCalls,
                  totalModelSteps: result.totalModelSteps,
                  retrySuppressed: true,
                },
              };

              this.appendTaskMessage(task.id, {
                category: "other",
                type: "task.status",
                text: `Task not completed: stopped by ${result.stopReason} (tools ${result.totalToolCalls}, model steps ${result.totalModelSteps})`,
              });

              throw new ControlledTaskStopError({
                stopReason: result.stopReason,
                message: `Task not completed: ${result.stopReason}`,
                details: {
                  segmentCount: result.segmentCount,
                  totalToolCalls: result.totalToolCalls,
                  totalModelSteps: result.totalModelSteps,
                },
              });
            }

            throw new Error(`Task not completed: ${result.stopReason}`);
          }

          return result.text;
        } catch (error) {
          this.handleFatalQueueErrorIfNeeded(task, error);
          throw error;
        }
      },
      {
        onTaskAttemptStart: (task) => {
          this.getAgent().beginTaskContext({
            id: task.id,
            type: task.type,
            input: task.input,
            retries: task.retries,
            startedAt: task.startedAt ?? Date.now(),
          });
        },
        onTaskAttemptSettled: (task) => {
          const finishedAt = task.finishedAt ?? Date.now();
          const attempts = task.retries + 1;

          if (task.status === TaskStatus.Pending) {
            this.getAgent().finishTaskContext(
              {
                id: task.id,
                type: task.type,
                status: "failed",
                finishedAt,
                retries: task.retries,
                attempts,
              },
              { recordLastTask: false, preserveCheckpoint: true },
            );
            return;
          }

          if (task.status === TaskStatus.Success) {
            this.getAgent().finishTaskContext({
              id: task.id,
              type: task.type,
              status: "success",
              finishedAt,
              retries: task.retries,
              attempts,
            });
            return;
          }

          if (task.status === TaskStatus.Cancelled) {
            this.getAgent().finishTaskContext({
              id: task.id,
              type: task.type,
              status: "cancelled",
              finishedAt,
              retries: task.retries,
              attempts,
            });
            return;
          }

          if (task.status === TaskStatus.Failed) {
            this.getAgent().finishTaskContext({
              id: task.id,
              type: task.type,
              status: "failed",
              finishedAt,
              retries: task.retries,
              attempts,
            });
          }
        },
      },
    );
  }

  private getAgent(sessionId = DEFAULT_AGENT_SESSION_ID): Agent {
    const agent = this.agentSessions.get(sessionId);
    if (!agent) {
      throw new Error(`Unknown agent session: ${sessionId}`);
    }
    return agent;
  }

  private async runAgentTask(
    task: TaskItem<string, string>,
    options?: {
      onOutputMessage?: (message: TaskOutputMessageDraft) => void;
    },
  ): Promise<{
    text: string;
    completed: boolean;
    stopReason: AgentRunDetailedResult["stopReason"];
    segmentCount: number;
    totalToolCalls: number;
    totalModelSteps: number;
  }> {
    const agent = this.getAgent();
    const maybeDetailed = agent as Agent & {
      runTaskDetailed?: (
        question: string,
        options?: {
          onOutputMessage?: (message: TaskOutputMessageDraft) => void;
        },
      ) => Promise<AgentRunDetailedResult>;
    };

    if (typeof maybeDetailed.runTaskDetailed === "function") {
      return await maybeDetailed.runTaskDetailed(task.input, options);
    }

    const text = await agent.runTask(task.input, options as any);
    return {
      text,
      completed: true,
      stopReason: "completed",
      segmentCount: 1,
      totalToolCalls: 0,
      totalModelSteps: 0,
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.taskQueue.start();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.taskQueue.stop();
  }

  updateSystemPrompt(prompt: string) {
    const hasRunningTask = this.taskQueue.getCurrentTask() !== null;
    this.getAgent().updateSystemPrompt(prompt, { syncMessages: !hasRunningTask });
  }

  submitTask(request: CreateTaskRequest): CreateTaskResponse {
    const task = createTask<string, string>(request.type ?? "http.input", request.input, {
      priority: request.priority ?? 2,
    });

    this.taskRegistry.set(task.id, task);
    this.ensureTaskMessageBuffer(task.id);
    this.appendTaskMessage(task.id, {
      category: "other",
      type: "task.status",
      text: "Task queued",
    });
    this.taskQueue.add(task);

    return {
      taskId: task.id,
      task: toTaskSnapshot(task),
    };
  }

  getTask(
    taskId: string,
    options?: {
      afterSeq?: number;
    },
  ): TaskStatusResponse | undefined {
    const task = this.taskRegistry.get(taskId);
    if (!task) return undefined;

    return {
      task: toTaskSnapshot(task),
      messages: this.getTaskMessagesDelta(taskId, options?.afterSeq ?? 0),
    };
  }

  getQueueStats(): QueueStats {
    return {
      size: this.taskQueue.size(),
    };
  }

  getAgentContext(): AgentContextResponse {
    const agent = this.getAgent() as Agent & {
      getContextProjectionSnapshot?: () => AgentContextResponse;
    };

    if (typeof agent.getContextProjectionSnapshot === "function") {
      return agent.getContextProjectionSnapshot();
    }

    const context = this.getAgent().getContextSnapshot();
    return {
      context,
      injectedContext: structuredClone(context),
      projectionDebug: {
        round: context.runtime.round,
        rawCounts: {
          core: context.memory.core.length,
          working: context.memory.working.length,
          ephemeral: context.memory.ephemeral.length,
          longterm: context.memory.longterm.length,
        },
        injectedCounts: {
          core: context.memory.core.length,
          working: context.memory.working.length,
          ephemeral: context.memory.ephemeral.length,
          longterm: context.memory.longterm.length,
        },
        droppedByReason: {
          working_status_terminal: 0,
          threshold_decay: 0,
          threshold_confidence: 0,
          expired_by_round: 0,
          over_max_items: 0,
          invalid_block: 0,
        },
        droppedSamples: {},
      },
    };
  }

  getAgentMessages(): AgentMessagesResponse {
    return {
      messages: this.getAgent().getMessagesSnapshot(),
    };
  }

  private getOperationalMemoryCoordinator(): PersistentMemoryCoordinator {
    const coordinator = this.persistentMemoryCoordinator;
    if (!coordinator || !coordinator.status.available) {
      throw new Error("Persistent memory unavailable");
    }
    return coordinator;
  }

  async memorySearch(request: AgentMemorySearchRequest): Promise<AgentMemorySearchResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    const result = await coordinator.search({
      query: request.query,
      limit: request.limit,
      mode: request.mode,
      hydrateTagRefs: request.hydrateTagRefs,
    });
    return result as AgentMemorySearchResponse;
  }

  async memoryGet(request: AgentMemoryGetRequest): Promise<AgentMemoryGetResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    const entry = await coordinator.get({
      entryId: request.entryId,
      blockId: request.blockId,
    });
    return { entry } as AgentMemoryGetResponse;
  }

  async memoryUpsert(request: AgentMemoryUpsertRequest): Promise<AgentMemoryUpsertResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    return await coordinator.upsert({
      items: request.items,
    }) as AgentMemoryUpsertResponse;
  }

  async memoryUpdate(request: AgentMemoryUpdateRequest): Promise<AgentMemoryUpdateResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    const entry = await coordinator.update({
      entryId: request.entryId,
      patch: request.patch,
    });
    return { entry } as AgentMemoryUpdateResponse;
  }

  async memoryDelete(request: AgentMemoryDeleteRequest): Promise<AgentMemoryDeleteResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    return await coordinator.delete({
      entryId: request.entryId,
      blockId: request.blockId,
    }) as AgentMemoryDeleteResponse;
  }

  async memoryFeedback(request: AgentMemoryFeedbackRequest): Promise<AgentMemoryFeedbackResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    return await coordinator.feedback({
      entryId: request.entryId,
      direction: request.direction,
    }) as AgentMemoryFeedbackResponse;
  }

  async memoryTagResolve(
    request: AgentMemoryTagResolveRequest,
  ): Promise<AgentMemoryTagResolveResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    return await coordinator.resolveTag({
      tagId: request.tagId,
      hydrateEntries: request.hydrateEntries,
    }) as AgentMemoryTagResolveResponse;
  }

  async memoryStats(): Promise<AgentMemoryStatsResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    return await coordinator.getStats() as AgentMemoryStatsResponse;
  }

  async memoryCompact(): Promise<AgentMemoryCompactResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    return await coordinator.compactNow() as AgentMemoryCompactResponse;
  }

  async memoryListRecent(
    request?: AgentMemoryListRecentRequest,
  ): Promise<AgentMemoryListRecentResponse> {
    const coordinator = this.getOperationalMemoryCoordinator();
    const entries = await coordinator.listRecent(request?.limit ?? 20);
    return { entries } as AgentMemoryListRecentResponse;
  }

  forceAbort(): ForceAbortResponse {
    const now = Date.now();
    const currentTask = this.taskQueue.getCurrentTask();
    if (currentTask) {
      currentTask.metadata = {
        ...(currentTask.metadata && typeof currentTask.metadata === "object" ? currentTask.metadata : {}),
        cancelReason: "forceabort",
        cancelledBy: "system.forceabort",
      };
    }
    const abortedCurrent = this.getAgent().abortCurrentRun("forceabort");
    const pending = this.taskQueue.drainPending();
    this.cancelPendingTasks(
      pending,
      now,
      "forceabort",
      "system.forceabort",
      "Task cancelled by force abort",
    );

    return {
      abortedCurrent,
      clearedPendingCount: pending.length,
      timestamp: now,
    };
  }

  private ensureTaskMessageBuffer(taskId: string): TaskMessageBuffer {
    const existing = this.taskMessages.get(taskId);
    if (existing) {
      return existing;
    }

    const created: TaskMessageBuffer = {
      items: [],
      nextSeq: 1,
      stepBase: 0,
      lastRawCompletedStep: 0,
    };
    this.taskMessages.set(taskId, created);
    return created;
  }

  private appendTaskMessage(taskId: string, message: TaskOutputMessageDraft): void {
    const buffer = this.ensureTaskMessageBuffer(taskId);
    const normalizedMessage = this.normalizeTaskMessageStep(buffer, message);
    const nextMessage: TaskOutputMessage = {
      ...(normalizedMessage as Omit<TaskOutputMessage, "seq" | "createdAt">),
      seq: buffer.nextSeq,
      createdAt: normalizedMessage.createdAt ?? Date.now(),
    } as TaskOutputMessage;

    buffer.items.push(nextMessage);
    buffer.nextSeq += 1;
  }

  private normalizeTaskMessageStep(
    buffer: TaskMessageBuffer,
    message: TaskOutputMessageDraft,
  ): TaskOutputMessageDraft {
    if (message.category === "tool" && typeof message.step !== "number") {
      return {
        ...message,
        step: buffer.stepBase + buffer.lastRawCompletedStep + 1,
      };
    }

    if (message.category !== "other" || message.type !== "step.finish") {
      return message;
    }

    const rawStep = message.step;
    if (typeof rawStep !== "number" || !Number.isFinite(rawStep) || rawStep <= 0) {
      return message;
    }

    if (rawStep <= buffer.lastRawCompletedStep) {
      // A new model segment started and step numbering restarted from 1.
      buffer.stepBase += buffer.lastRawCompletedStep;
      buffer.lastRawCompletedStep = 0;
    }

    buffer.lastRawCompletedStep = rawStep;

    return {
      ...message,
      step: buffer.stepBase + rawStep,
    };
  }

  private getTaskMessagesDelta(taskId: string, afterSeq: number): TaskMessagesDelta {
    const buffer = this.ensureTaskMessageBuffer(taskId);
    const normalizedAfterSeq = Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const items = buffer.items.filter((item) => item.seq > normalizedAfterSeq);
    const latestSeq = buffer.nextSeq - 1;

    return {
      items,
      latestSeq,
      nextSeq: latestSeq + 1,
    };
  }

  private handleFatalQueueErrorIfNeeded(task: TaskItem<string, string>, error: unknown): void {
    const message = this.toErrorMessage(error);
    if (!this.isContextLengthOverflowMessage(message)) {
      return;
    }

    // Prevent queue-level retry for this task after a context overflow.
    task.retries = task.maxRetries;
    task.metadata = {
      ...(task.metadata && typeof task.metadata === "object" ? task.metadata : {}),
      fatalErrorType: "context_overflow",
      retrySuppressed: true,
    };

    const now = Date.now();
    const pending = this.taskQueue.drainPending();
    this.cancelPendingTasks(
      pending,
      now,
      CONTEXT_OVERFLOW_CANCEL_REASON,
      CONTEXT_OVERFLOW_CANCELLED_BY,
      "Task cancelled: queue cleared after context length overflow",
    );

    this.logger.log(
      `[runtime] context length overflow detected on task ${task.id}; cleared ${pending.length} pending task(s)`,
    );
  }

  private cancelPendingTasks(
    tasks: TaskItem<string, string>[],
    now: number,
    cancelReason: string,
    cancelledBy: string,
    statusText: string,
  ): void {
    for (const task of tasks) {
      task.status = TaskStatus.Cancelled;
      task.finishedAt = now;
      task.metadata = {
        ...(task.metadata && typeof task.metadata === "object" ? task.metadata : {}),
        cancelReason,
        cancelledBy,
      };
      this.appendTaskMessage(task.id, {
        category: "other",
        type: "task.status",
        text: statusText,
      });
    }
  }

  private isContextLengthOverflowMessage(message: string): boolean {
    return /\bmaximum context length\b/i.test(message);
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
