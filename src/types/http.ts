import type { ModelMessage } from "ai";

import type { AgentContext } from "./agent";
import type { TaskItem, TaskPriority } from "./task";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

export type ApiSuccessResponse<T> = {
  ok: true;
  data: T;
};

export type ApiErrorResponse = {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export type TaskSnapshot = Pick<
  TaskItem<string, string>,
  | "id"
  | "type"
  | "priority"
  | "status"
  | "input"
  | "result"
  | "error"
  | "retries"
  | "maxRetries"
  | "createAt"
  | "startedAt"
  | "finishedAt"
  | "parentId"
  | "metadata"
  | "cancellable"
>;

export type CreateTaskRequest = {
  input: string;
  priority?: TaskPriority;
  type?: string;
};

export type CreateTaskResponse = {
  taskId: string;
  task: TaskSnapshot;
};

export type TaskStatusResponse = {
  task: TaskSnapshot;
};

export type QueueStats = {
  size: number;
};

export type HealthzResponse = {
  name: string;
  version: string;
  startupAt: number;
  queue: QueueStats;
};

export type AgentContextResponse = {
  context: AgentContext;
};

export type AgentMessagesResponse = {
  messages: ModelMessage[];
};
