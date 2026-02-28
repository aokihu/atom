/**
 * Prompt task execution flow for TUI mode.
 *
 * Purpose:
 * - Drive submit/poll/finalize sequence for user prompts.
 * - Emit structured callbacks so UI layers can react declaratively.
 */

import type { GatewayClient } from "../../../libs/channel/channel";
import type { TaskOutputMessage, TaskSnapshot } from "../../../types/http";
import { executePolledTask } from "../../shared/flows/task_polling";
import { summarizeCompletedTask, type CompletedTaskSummary } from "./task_flow";

type WithConnectionTracking = <T>(operation: () => Promise<T>) => Promise<T>;

export type PromptTaskFlowCallbacks = {
  onBeforeSubmit: () => void;
  onTaskCreated: (taskId: string) => void;
  onTaskStatus?: (taskId: string, task: TaskSnapshot) => void;
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
    const result = await executePolledTask({
      client,
      taskType: "tui.input",
      taskInput: question,
      pollIntervalMs,
      sleepFn,
      runClientOperation: withConnectionTracking,
      shouldStop: isDestroyed,
      onTaskCreated: callbacks.onTaskCreated,
      onTaskStatus: callbacks.onTaskStatus,
      onTaskMessages: callbacks.onTaskMessages,
    });

    if (result.stopped) return;

    const summary = summarizeCompletedTask(result.task);
    callbacks.onTaskCompleted(result.taskId, summary);
  } catch (error) {
    callbacks.onRequestError(formatErrorMessage(error));
  } finally {
    callbacks.onFinally();
  }
};
