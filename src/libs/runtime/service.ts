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
  TaskStatusResponse,
} from "../../types/http";
import type { TaskItem } from "../../types/task";

const DEFAULT_AGENT_SESSION_ID = "default";

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
        return await this.getAgent().runTask(task.input);
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
    this.taskQueue.add(task);

    return {
      taskId: task.id,
      task: toTaskSnapshot(task),
    };
  }

  getTask(taskId: string): TaskStatusResponse | undefined {
    const task = this.taskRegistry.get(taskId);
    if (!task) return undefined;

    return {
      task: toTaskSnapshot(task),
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
}
