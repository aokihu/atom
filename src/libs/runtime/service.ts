import { Agent } from "../agent/agent";
import { PriorityTaskQueue, createTask } from "./queue";

import type { RuntimeGateway } from "../channel/channel";
import type {
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
import { TaskStatus } from "../../types/task";

const DEFAULT_AGENT_SESSION_ID = "default";
const CONTEXT_OVERFLOW_CANCEL_REASON = "contextoverflow";
const CONTEXT_OVERFLOW_CANCELLED_BY = "system.contextoverflow";

type TaskMessageBuffer = {
  items: TaskOutputMessage[];
  nextSeq: number;
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
  private started = false;

  constructor(
    private readonly agent: Agent,
    private readonly logger: Pick<Console, "log"> = console,
  ) {
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
          return await this.getAgent().runTask(task.input, {
            onOutputMessage: (message) => {
              this.appendTaskMessage(task.id, message);
            },
          });
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
    return {
      context: this.getAgent().getContextSnapshot(),
    };
  }

  getAgentMessages(): AgentMessagesResponse {
    return {
      messages: this.getAgent().getMessagesSnapshot(),
    };
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
    };
    this.taskMessages.set(taskId, created);
    return created;
  }

  private appendTaskMessage(taskId: string, message: TaskOutputMessageDraft): void {
    const buffer = this.ensureTaskMessageBuffer(taskId);
    const nextMessage: TaskOutputMessage = {
      ...(message as Omit<TaskOutputMessage, "seq" | "createdAt">),
      seq: buffer.nextSeq,
      createdAt: message.createdAt ?? Date.now(),
    } as TaskOutputMessage;

    buffer.items.push(nextMessage);
    buffer.nextSeq += 1;
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
