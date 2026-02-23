export enum TaskStatus {
  Pending = "pending",
  Running = "running",
  Success = "success",
  Failed = "failed",
  Cancelled = "cancelled",
}

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

  metadata?: Record<string, any>;

  cancellable?: boolean; // 任务可以被取消
};

export interface TaskQueue {
  add(task: TaskItem<any, any>): void;
  start(): void;
  stop(): void;
  size(): number;
}
