export enum TaskStatus {
  Pending = "pending",
  Running = "running",
  Success = "success",
  Failed = "failed",
  Cancelled = "cancelled",
}

export const CONTROLLED_TASK_STOP_REASONS = [
  "tool_budget_exhausted",
  "step_limit_segment_continue",
  "model_step_budget_exhausted",
  "continuation_limit_reached",
] as const;

export type TaskExecutionStopReason = (typeof CONTROLLED_TASK_STOP_REASONS)[number];

export type TaskExecutionMetadata = {
  completed: boolean;
  stopReason: TaskExecutionStopReason;
  segmentCount?: number;
  totalToolCalls?: number;
  totalModelSteps?: number;
  retrySuppressed?: boolean;
};

export type TaskMetadata = Record<string, any> & {
  execution?: TaskExecutionMetadata;
};

export const isTaskExecutionStopReason = (value: unknown): value is TaskExecutionStopReason =>
  typeof value === "string" &&
  (CONTROLLED_TASK_STOP_REASONS as readonly string[]).includes(value);

export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/**
 * 任务记录单元
 */
export type TaskItem<TInput, TResult> = {
  id: string;
  type: string;
  priority: TaskPriority;
  status: TaskStatus;
  input: TInput;
  result?: TResult;
  error?: {
    message: string;
    stack?: string;
  };
  retries: number;
  maxRetries: number;

  createAt: number;
  startedAt?: number;
  finishedAt?: number;

  parentId?: string;

  metadata?: TaskMetadata;

  cancellable?: boolean; // 任务可以被取消
};

export interface TaskQueue {
  add(task: TaskItem<any, any>): void;
  start(): void;
  stop(): void;
  size(): number;
}
