import { describe, expect, test } from "bun:test";

import type { GatewayClient } from "../../../libs/channel/channel";
import type { TaskStatusResponse } from "../../../types/http";
import { TaskStatus } from "../../../types/task";
import { executePolledTask } from "./task_polling";

const createGatewayClient = (args: {
  responses: TaskStatusResponse[];
  onGetTask?: (afterSeq: number | undefined) => void;
}): GatewayClient => {
  let getTaskCallIndex = 0;

  return {
    async getHealth() {
      return {
        name: "atom",
        version: "test",
        startupAt: Date.now(),
        queue: { size: 0 },
      };
    },
    async createTask() {
      return {
        taskId: "task-1",
        task: {
          id: "task-1",
          type: "test.input",
          priority: 2,
          status: TaskStatus.Pending,
          input: "hello",
          retries: 0,
          maxRetries: 1,
          createAt: Date.now(),
          cancellable: true,
        },
      };
    },
    async getTask(_taskId, options) {
      args.onGetTask?.(options?.afterSeq);
      const response = args.responses[Math.min(getTaskCallIndex, args.responses.length - 1)];
      getTaskCallIndex += 1;
      if (!response) {
        throw new Error("missing task response");
      }
      return response;
    },
    async getAgentContext() {
      throw new Error("not implemented");
    },
    async getAgentMessages() {
      throw new Error("not implemented");
    },
    async forceAbort() {
      return {
        abortedCurrent: false,
        clearedPendingCount: 0,
        timestamp: Date.now(),
      };
    },
  };
};

describe("executePolledTask", () => {
  test("polls with afterSeq cursor and returns final task", async () => {
    const afterSeqCalls: Array<number | undefined> = [];
    const createdTaskIds: string[] = [];
    const receivedMessageCounts: number[] = [];
    const statusSnapshots: TaskStatus[] = [];
    const client = createGatewayClient({
      responses: [
        {
          task: {
            id: "task-1",
            type: "test.input",
            priority: 2,
            status: TaskStatus.Running,
            input: "hello",
            retries: 0,
            maxRetries: 1,
            createAt: Date.now(),
            cancellable: true,
          },
          messages: {
            items: [
              {
                seq: 1,
                createdAt: Date.now(),
                category: "assistant",
                type: "assistant.text",
                text: "partial",
                final: false,
              },
            ],
            nextSeq: 2,
            latestSeq: 1,
          },
        },
        {
          task: {
            id: "task-1",
            type: "test.input",
            priority: 2,
            status: TaskStatus.Success,
            input: "hello",
            result: "done",
            retries: 0,
            maxRetries: 1,
            createAt: Date.now(),
            cancellable: true,
          },
        },
      ],
      onGetTask: (afterSeq) => {
        afterSeqCalls.push(afterSeq);
      },
    });

    const result = await executePolledTask({
      client,
      taskType: "test.input",
      taskInput: "hello",
      pollIntervalMs: 0,
      sleepFn: async () => {},
      onTaskCreated: (taskId) => {
        createdTaskIds.push(taskId);
      },
      onTaskMessages: (_taskId, messages) => {
        receivedMessageCounts.push(messages.length);
      },
      onTaskStatus: (_taskId, task) => {
        statusSnapshots.push(task.status);
      },
    });

    expect(result.stopped).toBe(false);
    expect(result.taskId).toBe("task-1");
    expect(result.task.status).toBe(TaskStatus.Success);
    expect(afterSeqCalls).toEqual([0, 1]);
    expect(createdTaskIds).toEqual(["task-1"]);
    expect(receivedMessageCounts).toEqual([1]);
    expect(statusSnapshots).toEqual([TaskStatus.Running, TaskStatus.Success]);
  });

  test("stops before polling when shouldStop is true after task creation", async () => {
    let getTaskCalls = 0;
    let createdTaskIds = 0;
    const client = createGatewayClient({
      responses: [],
      onGetTask: () => {
        getTaskCalls += 1;
      },
    });

    const result = await executePolledTask({
      client,
      taskType: "test.input",
      taskInput: "hello",
      pollIntervalMs: 0,
      sleepFn: async () => {},
      shouldStop: () => true,
      onTaskCreated: () => {
        createdTaskIds += 1;
      },
    });

    expect(result.stopped).toBe(true);
    expect(result.taskId).toBe("task-1");
    expect(result.task.status).toBe(TaskStatus.Pending);
    expect(getTaskCalls).toBe(0);
    expect(createdTaskIds).toBe(0);
  });
});
