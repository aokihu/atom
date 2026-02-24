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

export type TaskOutputMessageCategory = "assistant" | "tool" | "other";

export type TaskOutputMessage =
  | {
      seq: number;
      createdAt: number;
      category: "assistant";
      type: "assistant.text";
      text: string;
      final: boolean;
      step?: number;
    }
  | {
      seq: number;
      createdAt: number;
      category: "tool";
      type: "tool.call";
      step?: number;
      toolCallId?: string;
      toolName: string;
      inputSummary?: string;
    }
  | {
      seq: number;
      createdAt: number;
      category: "tool";
      type: "tool.result";
      step?: number;
      toolCallId?: string;
      toolName: string;
      ok: boolean;
      outputSummary?: string;
      errorMessage?: string;
    }
  | {
      seq: number;
      createdAt: number;
      category: "other";
      type: "task.status" | "step.finish" | "task.finish" | "task.error";
      text: string;
      step?: number;
      finishReason?: string;
    };

export type TaskOutputMessageDraft =
  | {
      createdAt?: number;
      category: "assistant";
      type: "assistant.text";
      text: string;
      final: boolean;
      step?: number;
    }
  | {
      createdAt?: number;
      category: "tool";
      type: "tool.call";
      step?: number;
      toolCallId?: string;
      toolName: string;
      inputSummary?: string;
    }
  | {
      createdAt?: number;
      category: "tool";
      type: "tool.result";
      step?: number;
      toolCallId?: string;
      toolName: string;
      ok: boolean;
      outputSummary?: string;
      errorMessage?: string;
    }
  | {
      createdAt?: number;
      category: "other";
      type: "task.status" | "step.finish" | "task.finish" | "task.error";
      text: string;
      step?: number;
      finishReason?: string;
    };

export type TaskMessagesDelta = {
  items: TaskOutputMessage[];
  nextSeq: number;
  latestSeq: number;
};

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
  messages?: TaskMessagesDelta;
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
