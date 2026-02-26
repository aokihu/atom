/**
 * 任务队列
 * @author aokihu <aokihu@gmail.com>
 */

import { type TaskQueue, type TaskItem, TaskStatus } from "../../../types/task";
import { isNonRetryableTaskError } from "../errors";

type Task = TaskItem<any, any>;

export type PriorityTaskQueueHooks = {
  onTaskAttemptStart?: (task: Task) => void;
  onTaskAttemptSettled?: (task: Task) => void;
};

export class PriorityTaskQueue implements TaskQueue {
  private heap: Task[] = [];
  private running = false;
  private current: Task | null = null;

  constructor(
    private executor: (task: Task) => Promise<any>,
    private readonly hooks: PriorityTaskQueueHooks = {},
  ) {}

  add(task: Task) {
    this.push(task);
    this.schedule();
  }

  start() {
    this.running = true;
    this.schedule();
  }

  stop() {
    this.running = false;
  }

  size() {
    return this.heap.length;
  }

  getCurrentTask(): Task | null {
    return this.current;
  }

  drainPending(): Task[] {
    const drained = this.heap.slice();
    this.heap = [];
    return drained;
  }

  private get(index: number): Task {
    const item = this.heap[index];
    if (!item) {
      throw new Error("Heap invariant broken");
    }
    return item;
  }

  private schedule() {
    if (!this.running) return;
    if (this.current) return; // 串行锁
    if (this.heap.length === 0) return;

    const task = this.pop();
    if (!task) return;

    this.execute(task);
  }

  private async execute(task: Task) {
    this.current = task;

    task.status = TaskStatus.Running;
    task.startedAt = Date.now();
    this.safeRunHook(this.hooks.onTaskAttemptStart, task);

    try {
      const result = await this.executor(task);
      task.result = result;
      task.status = TaskStatus.Success;
    } catch (err: any) {
      if (this.wasForceCancelled(task) || this.isAbortError(err)) {
        task.status = TaskStatus.Cancelled;
      } else {
        task.status = TaskStatus.Failed;
        task.error = { message: err?.message ?? String(err) };

        if (!isNonRetryableTaskError(err) && task.retries < task.maxRetries) {
          task.retries++;
          task.status = TaskStatus.Pending;
          this.push(task);
        }
      }
    } finally {
      task.finishedAt = Date.now();
      this.safeRunHook(this.hooks.onTaskAttemptSettled, task);
      this.current = null;
      this.schedule(); // 执行下一个
    }
  }

  private push(task: Task) {
    this.heap.push(task);
    this.bubbleUp(this.heap.length - 1);
  }

  private pop(): Task | undefined {
    if (this.heap.length === 0) return undefined;

    const top = this.heap[0];
    const end = this.heap.pop()!;

    if (this.heap.length > 0) {
      this.heap[0] = end;
      this.sinkDown(0);
    }

    return top;
  }

  private bubbleUp(index: number) {
    const element = this.heap[index]; // 一定存在
    if (!element) return;

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.get(parentIndex);

      if (element.priority >= parent.priority) break;

      this.heap[parentIndex] = element;
      this.heap[index] = parent;
      index = parentIndex;
    }
  }

  private sinkDown(index: number) {
    const length = this.heap.length;
    const element = this.heap[index];
    if (!element) return;

    while (true) {
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      let swap: number | null = null;

      if (left < length) {
        const leftItem = this.heap[left];
        if (leftItem && leftItem.priority < element.priority) {
          swap = left;
        }
      }

      if (right < length) {
        const rightItem = this.heap[right];

        const comparePriority =
          swap === null ? element.priority : this.heap[swap]!.priority;

        if (rightItem && rightItem.priority < comparePriority) {
          swap = right;
        }
      }

      if (swap === null) break;

      this.heap[index] = this.get(swap);
      this.heap[swap] = element;
      index = swap;
    }
  }

  private isAbortError(err: unknown): boolean {
    if (!err) {
      return false;
    }

    if (typeof err === "string") {
      return /\b(abort|aborted|cancelled|canceled)\b/i.test(err);
    }

    if (typeof err !== "object") {
      return false;
    }

    const name = "name" in err ? String((err as { name?: unknown }).name ?? "") : "";
    if (name === "AbortError") {
      return true;
    }

    const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
    if (code === "ABORT_ERR") {
      return true;
    }

    const message = "message" in err ? String((err as { message?: unknown }).message ?? "") : "";
    if (/\b(abort|aborted|cancelled|canceled)\b/i.test(message)) {
      return true;
    }

    const cause = (err as { cause?: unknown }).cause;
    if (cause && cause !== err) {
      return this.isAbortError(cause);
    }

    return false;
  }

  private wasForceCancelled(task: Task): boolean {
    if (!task.metadata || typeof task.metadata !== "object") {
      return false;
    }

    return (task.metadata as Record<string, unknown>).cancelReason === "forceabort";
  }

  private safeRunHook(hook: ((task: Task) => void) | undefined, task: Task) {
    if (!hook) {
      return;
    }

    try {
      hook(task);
    } catch {
      // Hooks are observational/coordinating only; queue progress must not be blocked.
    }
  }
}
