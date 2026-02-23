import type {
  AgentContextResponse,
  AgentMessagesResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  HealthzResponse,
  QueueStats,
  TaskStatusResponse,
} from "../../types/http";

export type MaybePromise<T> = T | Promise<T>;

export interface RuntimeGateway {
  submitTask(request: CreateTaskRequest): MaybePromise<CreateTaskResponse>;
  getTask(taskId: string): MaybePromise<TaskStatusResponse | undefined>;
  getQueueStats(): MaybePromise<QueueStats>;
  getAgentContext(): MaybePromise<AgentContextResponse>;
  getAgentMessages(): MaybePromise<AgentMessagesResponse>;
}

export interface GatewayClient {
  getHealth(): Promise<HealthzResponse>;
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(taskId: string): Promise<TaskStatusResponse>;
  getAgentContext(): Promise<AgentContextResponse>;
  getAgentMessages(): Promise<AgentMessagesResponse>;
}
