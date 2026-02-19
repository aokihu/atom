/**
 * 工厂方法
 */

import { TaskStatus, type TaskItem } from "../../../types/task";

export function createTask<TInput, TResult>(
  type: string,
  input: TInput,
  options?: Partial<TaskItem<TInput, TResult>>,
) {
  return {
    id: Bun.randomUUIDv7(),
    type,
    priority: 2,
    status: TaskStatus.Pending,
    input,
    retries: 0,
    maxRetries: 3,
    createAt: Date.now(),
    ...options,
  } satisfies TaskItem<TInput, TResult>;
}
