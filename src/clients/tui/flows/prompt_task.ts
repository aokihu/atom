/**
 * Prompt task execution flow for TUI mode.
 *
 * Purpose:
 * - Drive submit/poll/finalize sequence for user prompts.
 * - Emit structured callbacks so UI layers can react declaratively.
 */

import type { GatewayClient } from "../../../libs/channel/channel";
import type { TaskOutputMessage, TaskStatusResponse } from "../../../types/http";
import { summarizeCompletedTask, isTaskStillRunning, type CompletedTaskSummary } from "./task_flow";

type WithConnectionTracking = <T>(operation: () => Promise<T>) => Promise<T>;

export type PromptTaskFlowCallbacks = {
  onBeforeSubmit: () => void;
  onTaskCreated: (taskId: string) => void;
  onTaskMessages?: (taskId: string, messages: TaskOutputMessage[]) => void;
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
    let afterSeq = 0;

    while (!isDestroyed()) {
      const status: TaskStatusResponse = await withConnectionTracking(() =>
        client.getTask(created.taskId, { afterSeq }),
      );
      const task = status.task;
      const delta = status.messages;

      if (delta) {
        afterSeq = delta.latestSeq;

        if (delta.items.length > 0) {
          callbacks.onTaskMessages?.(created.taskId, delta.items);
        }
      }

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
