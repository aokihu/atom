import { Agent } from "../agent/agent";
import { PriorityTaskQueue, createTask } from "./queue";

import type { RuntimeGateway } from "../channel/channel";
import type {
  AgentContextResponse,
  AgentMessagesResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  QueueStats,
  TaskSnapshot,
  TaskMessagesDelta,
  TaskOutputMessage,
  TaskOutputMessageDraft,
  TaskStatusResponse,
} from "../../types/http";
import type { TaskItem } from "../../types/task";

const DEFAULT_AGENT_SESSION_ID = "default";

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

        return await this.getAgent().runTask(task.input, {
          onOutputMessage: (message) => {
            this.appendTaskMessage(task.id, message);
          },
        });
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
}
