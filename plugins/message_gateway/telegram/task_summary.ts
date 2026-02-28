import type { TaskExecutionMetadata, TaskSnapshot, TaskStatus } from "../shared/types";

export type CompletedTaskSummary =
  | { kind: "assistant_reply"; logKind: "assistant"; statusNotice: string; replyText: string }
  | { kind: "system"; logKind: "system"; statusNotice: string }
  | { kind: "error"; logKind: "error"; statusNotice: string };

type TaskLike = Pick<TaskSnapshot, "status" | "result" | "error" | "metadata">;

const CONTROLLED_TASK_STOP_REASONS = [
  "tool_budget_exhausted",
  "step_limit_segment_continue",
  "model_step_budget_exhausted",
  "continuation_limit_reached",
  "tool_policy_blocked",
  "intent_execution_failed",
] as const;

const isTaskExecutionStopReason = (value: unknown): value is TaskExecutionMetadata["stopReason"] =>
  typeof value === "string" &&
  (CONTROLLED_TASK_STOP_REASONS as readonly string[]).includes(value);

export const isTaskStillRunning = (status: TaskStatus): boolean =>
  status === "pending" || status === "running";

const formatStopReason = (reason: string): string => reason.replaceAll("_", " ");

const extractExecutionStopMetadata = (task: TaskLike): TaskExecutionMetadata | null => {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const executionRaw = (metadata as Record<string, unknown>).execution;
  if (!executionRaw || typeof executionRaw !== "object") {
    return null;
  }

  const execution = executionRaw as Record<string, unknown>;
  if (execution.completed !== false) {
    return null;
  }

  const stopReason = execution.stopReason;
  if (!isTaskExecutionStopReason(stopReason)) {
    return null;
  }

  return {
    completed: false,
    stopReason,
    segmentCount:
      typeof execution.segmentCount === "number" ? execution.segmentCount : undefined,
    totalToolCalls:
      typeof execution.totalToolCalls === "number" ? execution.totalToolCalls : undefined,
    totalModelSteps:
      typeof execution.totalModelSteps === "number" ? execution.totalModelSteps : undefined,
    retrySuppressed:
      typeof execution.retrySuppressed === "boolean" ? execution.retrySuppressed : undefined,
  };
};

export const summarizeCompletedTask = (task: TaskLike): CompletedTaskSummary => {
  if (task.status === "success") {
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

  if (task.status === "failed") {
    const execution = extractExecutionStopMetadata(task);
    if (execution) {
      const parts = [`Task not completed: ${formatStopReason(execution.stopReason)}`];
      const stats: string[] = [];
      if (typeof execution.totalToolCalls === "number") {
        stats.push(`tools ${execution.totalToolCalls}`);
      }
      if (typeof execution.totalModelSteps === "number") {
        stats.push(`model steps ${execution.totalModelSteps}`);
      }
      if (typeof execution.segmentCount === "number") {
        stats.push(`segments ${execution.segmentCount}`);
      }
      if (stats.length > 0) {
        parts.push(`(${stats.join(", ")})`);
      }

      return {
        kind: "system",
        logKind: "system",
        statusNotice: parts.join(" "),
      };
    }

    const message = task.error?.message ?? "Unknown error";
    return {
      kind: "error",
      logKind: "error",
      statusNotice: `Task failed: ${message}`,
    };
  }

  if (task.status === "cancelled") {
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
