import type {
  AgentContextResponse,
  AgentMessagesResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ForceAbortResponse,
  HealthzResponse,
  QueueStats,
  TaskStatusResponse,
} from "../../types/http";

export type MaybePromise<T> = T | Promise<T>;
export type GetTaskOptions = {
  afterSeq?: number;
};

export interface RuntimeGateway {
  submitTask(request: CreateTaskRequest): MaybePromise<CreateTaskResponse>;
  getTask(taskId: string, options?: GetTaskOptions): MaybePromise<TaskStatusResponse | undefined>;
  getQueueStats(): MaybePromise<QueueStats>;
  getAgentContext(): MaybePromise<AgentContextResponse>;
  getAgentMessages(): MaybePromise<AgentMessagesResponse>;
  forceAbort(): MaybePromise<ForceAbortResponse>;
}

export interface GatewayClient {
  getHealth(options?: { probeMcpHttp?: boolean }): Promise<HealthzResponse>;
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(taskId: string, options?: GetTaskOptions): Promise<TaskStatusResponse>;
  getAgentContext(): Promise<AgentContextResponse>;
  getAgentMessages(): Promise<AgentMessagesResponse>;
  forceAbort(): Promise<ForceAbortResponse>;
}
