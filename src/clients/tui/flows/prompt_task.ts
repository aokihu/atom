import type { GatewayClient } from "../../../libs/channel/channel";
import type { TaskStatusResponse } from "../../../types/http";
import { summarizeCompletedTask, isTaskStillRunning, type CompletedTaskSummary } from "./task_flow";

type WithConnectionTracking = <T>(operation: () => Promise<T>) => Promise<T>;

export type PromptTaskFlowCallbacks = {
  onBeforeSubmit: () => void;
  onTaskCreated: (taskId: string) => void;
  onTaskCompleted: (taskId: string, summary: CompletedTaskSummary) => void;
  onRequestError: (message: string) => void;
  onFinally: () => void;
};

export type ExecutePromptTaskFlowInput = {
  question: string;
  client: GatewayClient;
  pollIntervalMs: number;
  sleepFn: (ms: number) => Promise<void>;
  withConnectionTracking: WithConnectionTracking;
  isDestroyed: () => boolean;
  formatErrorMessage: (error: unknown) => string;
  callbacks: PromptTaskFlowCallbacks;
};

export const executePromptTaskFlow = async (input: ExecutePromptTaskFlowInput): Promise<void> => {
  const {
    question,
    client,
    pollIntervalMs,
    sleepFn,
    withConnectionTracking,
    isDestroyed,
    formatErrorMessage,
    callbacks,
  } = input;

  callbacks.onBeforeSubmit();

  try {
    const created = await withConnectionTracking(() =>
      client.createTask({
        type: "tui.input",
        input: question,
      }),
    );

    if (isDestroyed()) return;

    callbacks.onTaskCreated(created.taskId);

    while (!isDestroyed()) {
      const status: TaskStatusResponse = await withConnectionTracking(() => client.getTask(created.taskId));
      const task = status.task;

      if (isTaskStillRunning(task.status)) {
        await sleepFn(pollIntervalMs);
        continue;
      }

      const summary = summarizeCompletedTask(task);
      callbacks.onTaskCompleted(created.taskId, summary);
      break;
    }
  } catch (error) {
    callbacks.onRequestError(formatErrorMessage(error));
  } finally {
    callbacks.onFinally();
  }
};
