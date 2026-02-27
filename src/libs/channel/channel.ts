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
  memorySearch?(request: AgentMemorySearchRequest): MaybePromise<AgentMemorySearchResponse>;
  memoryGet?(request: AgentMemoryGetRequest): MaybePromise<AgentMemoryGetResponse>;
  memoryUpsert?(request: AgentMemoryUpsertRequest): MaybePromise<AgentMemoryUpsertResponse>;
  memoryUpdate?(request: AgentMemoryUpdateRequest): MaybePromise<AgentMemoryUpdateResponse>;
  memoryDelete?(request: AgentMemoryDeleteRequest): MaybePromise<AgentMemoryDeleteResponse>;
  memoryFeedback?(request: AgentMemoryFeedbackRequest): MaybePromise<AgentMemoryFeedbackResponse>;
  memoryTagResolve?(request: AgentMemoryTagResolveRequest): MaybePromise<AgentMemoryTagResolveResponse>;
  memoryStats?(): MaybePromise<AgentMemoryStatsResponse>;
  memoryCompact?(): MaybePromise<AgentMemoryCompactResponse>;
  memoryListRecent?(request?: AgentMemoryListRecentRequest): MaybePromise<AgentMemoryListRecentResponse>;
  forceAbort(): MaybePromise<ForceAbortResponse>;
}

export interface GatewayClient {
  getHealth(options?: { probeMcpHttp?: boolean }): Promise<HealthzResponse>;
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(taskId: string, options?: GetTaskOptions): Promise<TaskStatusResponse>;
  getAgentContext(): Promise<AgentContextResponse>;
  getAgentMessages(): Promise<AgentMessagesResponse>;
  memorySearch?(request: AgentMemorySearchRequest): Promise<AgentMemorySearchResponse>;
  memoryGet?(request: AgentMemoryGetRequest): Promise<AgentMemoryGetResponse>;
  memoryUpsert?(request: AgentMemoryUpsertRequest): Promise<AgentMemoryUpsertResponse>;
  memoryUpdate?(request: AgentMemoryUpdateRequest): Promise<AgentMemoryUpdateResponse>;
  memoryDelete?(request: AgentMemoryDeleteRequest): Promise<AgentMemoryDeleteResponse>;
  memoryFeedback?(request: AgentMemoryFeedbackRequest): Promise<AgentMemoryFeedbackResponse>;
  memoryTagResolve?(request: AgentMemoryTagResolveRequest): Promise<AgentMemoryTagResolveResponse>;
  memoryStats?(): Promise<AgentMemoryStatsResponse>;
  memoryCompact?(): Promise<AgentMemoryCompactResponse>;
  memoryListRecent?(request?: AgentMemoryListRecentRequest): Promise<AgentMemoryListRecentResponse>;
  forceAbort(): Promise<ForceAbortResponse>;
}
