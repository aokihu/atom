/**
 * 任务队列
 * @author aokihu <aokihu@gmail.com>
 */

import { type TaskQueue, type TaskItem, TaskStatus } from "../../../types/task";

type Task = TaskItem<any, any>;

export class PriorityTaskQueue implements TaskQueue {
  private heap: Task[] = [];
  private running = false;
  private current: Task | null = null;

  constructor(private executor: (task: Task) => Promise<any>) {}

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

    try {
      const result = await this.executor(task);
      task.result = result;
      task.status = TaskStatus.Success;
    } catch (err: any) {
      task.status = TaskStatus.Failed;
      task.error = { message: err.message };

      if (task.retries < task.maxRetries) {
        task.retries++;
        task.status = TaskStatus.Pending;
        this.push(task);
      }
    } finally {
      task.finishedAt = Date.now();
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
}
