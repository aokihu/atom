import { describe, expect, test } from "bun:test";
import { TaskStatus, type TaskItem } from "../../../types/task";
import { createTask } from "./factory";
import { PriorityTaskQueue } from "./task_queue";

const waitUntil = async (
  check: () => boolean,
  timeoutMs = 1000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timeout");
    }
    await Bun.sleep(1);
  }
};

const snapshotTask = (task: TaskItem<any, any>) => ({
  id: task.id,
  status: task.status,
  retries: task.retries,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt,
});

describe("PriorityTaskQueue lifecycle hooks", () => {
  test("emits start and settled hooks around a successful attempt", async () => {
    const starts: Array<ReturnType<typeof snapshotTask>> = [];
    const settled: Array<ReturnType<typeof snapshotTask>> = [];

    const queue = new PriorityTaskQueue(
      async () => "ok",
      {
        onTaskAttemptStart: (task) => {
          starts.push(snapshotTask(task));
        },
        onTaskAttemptSettled: (task) => {
          settled.push(snapshotTask(task));
        },
      },
    );

    const task = createTask<string, string>("test", "hello");
    queue.add(task);
    queue.start();

    await waitUntil(() => task.status === TaskStatus.Success && settled.length === 1);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.status).toBe(TaskStatus.Running);
    expect(typeof starts[0]?.startedAt).toBe("number");
    expect(starts[0]?.finishedAt).toBeUndefined();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe(TaskStatus.Success);
    expect(typeof settled[0]?.startedAt).toBe("number");
    expect(typeof settled[0]?.finishedAt).toBe("number");
  });

  test("emits settled hook with pending on retryable failure, then success on retry", async () => {
    const starts: Array<ReturnType<typeof snapshotTask>> = [];
    const settled: Array<ReturnType<typeof snapshotTask>> = [];
    let attempts = 0;

    const queue = new PriorityTaskQueue(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary failure");
        }
        return "ok";
      },
      {
        onTaskAttemptStart: (task) => {
          starts.push(snapshotTask(task));
        },
        onTaskAttemptSettled: (task) => {
          settled.push(snapshotTask(task));
        },
      },
    );

    const task = createTask<string, string>("test", "hello", { maxRetries: 1 });
    queue.add(task);
    queue.start();

    await waitUntil(() => task.status === TaskStatus.Success && settled.length === 2);

    expect(starts.map((item) => item.status)).toEqual([TaskStatus.Running, TaskStatus.Running]);
    expect(settled[0]?.status).toBe(TaskStatus.Pending);
    expect(settled[0]?.retries).toBe(1);
    expect(typeof settled[0]?.finishedAt).toBe("number");
    expect(settled[1]?.status).toBe(TaskStatus.Success);
    expect(settled[1]?.retries).toBe(1);
  });

  test("emits cancelled terminal state for abort-like errors", async () => {
    const settled: Array<ReturnType<typeof snapshotTask>> = [];

    const queue = new PriorityTaskQueue(
      async () => {
        throw new Error("request aborted by user");
      },
      {
        onTaskAttemptSettled: (task) => {
          settled.push(snapshotTask(task));
        },
      },
    );

    const task = createTask<string, string>("test", "hello", { maxRetries: 5 });
    queue.add(task);
    queue.start();

    await waitUntil(() => task.status === TaskStatus.Cancelled && settled.length === 1);

    expect(task.retries).toBe(0);
    expect(settled[0]?.status).toBe(TaskStatus.Cancelled);
    expect(typeof settled[0]?.finishedAt).toBe("number");
  });
});
