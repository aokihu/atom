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
export type TaskItem = {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  type: string;
};
