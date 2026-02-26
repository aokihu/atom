import type { TaskExecutionStopReason } from "../../types/task";

export class ControlledTaskStopError extends Error {
  readonly retryable = false;
  readonly stopReason: TaskExecutionStopReason;
  readonly details: {
    segmentCount?: number;
    totalToolCalls?: number;
    totalModelSteps?: number;
  };

  constructor(args: {
    stopReason: TaskExecutionStopReason;
    message?: string;
    details?: {
      segmentCount?: number;
      totalToolCalls?: number;
      totalModelSteps?: number;
    };
  }) {
    super(args.message ?? `Task not completed: ${args.stopReason}`);
    this.name = "ControlledTaskStopError";
    this.stopReason = args.stopReason;
    this.details = args.details ?? {};
  }
}

export const isNonRetryableTaskError = (
  error: unknown,
): error is { retryable: false; message?: unknown } => {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "retryable" in error && (error as { retryable?: unknown }).retryable === false;
};
