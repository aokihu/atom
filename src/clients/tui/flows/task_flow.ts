import { TaskStatus } from "../../../types/task";

export type CompletedTaskSummary =
  | { kind: "assistant_reply"; logKind: "assistant"; statusNotice: string; replyText: string }
  | { kind: "system"; logKind: "system"; statusNotice: string }
  | { kind: "error"; logKind: "error"; statusNotice: string };

type TaskLike = {
  status: TaskStatus;
  result?: string;
  error?: {
    message?: string;
  } | null;
};

export const isTaskStillRunning = (status: TaskStatus): boolean =>
  status === TaskStatus.Pending || status === TaskStatus.Running;

export const summarizeCompletedTask = (task: TaskLike): CompletedTaskSummary => {
  if (task.status === TaskStatus.Success) {
    if (task.result !== undefined) {
      return {
        kind: "assistant_reply",
        logKind: "assistant",
        statusNotice: `Reply received (${task.result.length} chars)`,
        replyText: task.result,
      };
    }

    return {
      kind: "system",
      logKind: "system",
      statusNotice: "Task succeeded with empty result.",
    };
  }

  if (task.status === TaskStatus.Failed) {
    const message = task.error?.message ?? "Unknown error";
    return {
      kind: "error",
      logKind: "error",
      statusNotice: `Task failed: ${message}`,
    };
  }

  if (task.status === TaskStatus.Cancelled) {
    return {
      kind: "system",
      logKind: "system",
      statusNotice: "Task was cancelled.",
    };
  }

  return {
    kind: "system",
    logKind: "system",
    statusNotice: `Task completed with unexpected status: ${task.status}`,
  };
};
