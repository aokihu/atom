import * as cronParser from "cron-parser";
import type {
  CancelScheduleResponse,
  CreateScheduleRequest,
  CreateScheduleResponse,
  ListSchedulesResponse,
  ScheduledTaskRecord,
  ScheduleTrigger,
} from "../../../types/schedule";

const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_TASK_TYPE = "scheduled.input";
const DEFAULT_TASK_PRIORITY = 2 as const;

type TimerHandle = ReturnType<typeof setTimeout>;

type ScheduledTaskState = {
  record: ScheduledTaskRecord;
  timer: TimerHandle | null;
};

export type ScheduledTaskTriggerEvent = {
  record: ScheduledTaskRecord;
  plannedAt: number;
};

export type ScheduledTaskManager = {
  createSchedule: (request: CreateScheduleRequest) => CreateScheduleResponse;
  listSchedules: () => ListSchedulesResponse;
  cancelSchedule: (scheduleId: string) => CancelScheduleResponse;
};

type ScheduledTaskManagerArgs = {
  onTrigger: (event: ScheduledTaskTriggerEvent) => void | Promise<void>;
  logger?: Pick<Console, "warn">;
  now?: () => number;
};

const normalizeNonEmptyString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
};

const parseAtTriggerTimestamp = (trigger: Extract<ScheduleTrigger, { mode: "at" }>): number => {
  const runAt = normalizeNonEmptyString(trigger.runAt, "trigger.runAt");
  const parsed = Date.parse(runAt);
  if (!Number.isFinite(parsed)) {
    throw new Error("trigger.runAt must be a valid ISO datetime");
  }
  return parsed;
};

const parseDelayTriggerTimestamp = (
  trigger: Extract<ScheduleTrigger, { mode: "delay" }>,
  now: number,
): number => {
  if (!Number.isFinite(trigger.delaySeconds) || trigger.delaySeconds <= 0) {
    throw new Error("trigger.delaySeconds must be > 0");
  }
  return now + Math.round(trigger.delaySeconds * 1000);
};

const toNextCronTimestamp = (cron: string, currentDate: Date): number => {
  const parser = cronParser as unknown as {
    parseExpression?: (expression: string, options: Record<string, unknown>) => {
      next: () => unknown;
    };
    CronExpressionParser?: {
      parse?: (expression: string, options: Record<string, unknown>) => {
        next: () => unknown;
      };
    };
  };

  const options = {
    currentDate,
    tz: "UTC",
  } satisfies Record<string, unknown>;

  const interval =
    parser.CronExpressionParser?.parse?.(cron, options) ??
    parser.parseExpression?.(cron, options);
  if (!interval) {
    throw new Error("cron-parser API unavailable");
  }

  const raw = interval.next();
  if (raw instanceof Date) {
    return raw.getTime();
  }

  if (typeof raw === "object" && raw !== null) {
    const maybeDate = raw as {
      toDate?: () => Date;
      getTime?: () => number;
      valueOf?: () => number;
    };
    if (typeof maybeDate.toDate === "function") {
      return maybeDate.toDate().getTime();
    }
    if (typeof maybeDate.getTime === "function") {
      return maybeDate.getTime();
    }
    if (typeof maybeDate.valueOf === "function") {
      const value = maybeDate.valueOf();
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }

  throw new Error("Unable to resolve next cron occurrence");
};

const parseCronTriggerTimestamp = (
  trigger: Extract<ScheduleTrigger, { mode: "cron" }>,
  now: number,
): number => {
  if (trigger.timezone !== "UTC") {
    throw new Error("trigger.timezone must be UTC");
  }
  const cron = normalizeNonEmptyString(trigger.cron, "trigger.cron");
  return toNextCronTimestamp(cron, new Date(now));
};

const computeInitialNextRunAt = (trigger: ScheduleTrigger, now: number): number => {
  if (trigger.mode === "delay") {
    return parseDelayTriggerTimestamp(trigger, now);
  }
  if (trigger.mode === "at") {
    return parseAtTriggerTimestamp(trigger);
  }
  return parseCronTriggerTimestamp(trigger, now);
};

const computeFollowingCronRunAt = (
  trigger: Extract<ScheduleTrigger, { mode: "cron" }>,
  fromMs: number,
): number => toNextCronTimestamp(trigger.cron, new Date(fromMs + 1));

const normalizeTrigger = (trigger: ScheduleTrigger): ScheduleTrigger => {
  if (trigger.mode === "cron") {
    return {
      ...trigger,
      timezone: "UTC",
      cron: normalizeNonEmptyString(trigger.cron, "trigger.cron"),
    };
  }

  if (trigger.mode === "at") {
    return {
      ...trigger,
      runAt: normalizeNonEmptyString(trigger.runAt, "trigger.runAt"),
    };
  }

  return trigger;
};

export class InMemoryScheduledTaskManager implements ScheduledTaskManager {
  private readonly states = new Map<string, ScheduledTaskState>();
  private readonly logger: Pick<Console, "warn">;
  private readonly now: () => number;

  constructor(private readonly args: ScheduledTaskManagerArgs) {
    this.logger = args.logger ?? console;
    this.now = args.now ?? (() => Date.now());
  }

  createSchedule(request: CreateScheduleRequest): CreateScheduleResponse {
    const now = this.now();
    const dedupeKey = normalizeNonEmptyString(request.dedupeKey, "dedupeKey");
    const taskInput = normalizeNonEmptyString(request.taskInput, "taskInput");
    const taskType = request.taskType?.trim() ? request.taskType.trim() : DEFAULT_TASK_TYPE;
    const priority = request.priority ?? DEFAULT_TASK_PRIORITY;
    const trigger = normalizeTrigger(request.trigger);
    const nextRunAt = computeInitialNextRunAt(trigger, now);

    if (!Number.isFinite(nextRunAt)) {
      throw new Error("Unable to compute next schedule run time");
    }

    if ((trigger.mode === "delay" || trigger.mode === "at") && nextRunAt <= now) {
      throw new Error("trigger time must be in the future");
    }

    const record: ScheduledTaskRecord = {
      scheduleId: Bun.randomUUIDv7(),
      dedupeKey,
      taskInput,
      taskType,
      priority,
      trigger,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    };

    this.states.set(record.scheduleId, {
      record,
      timer: null,
    });
    this.armTimer(record.scheduleId);

    return {
      schedule: { ...record },
    };
  }

  listSchedules(): ListSchedulesResponse {
    const items = Array.from(this.states.values())
      .map((state) => ({ ...state.record }))
      .sort((left, right) => left.nextRunAt - right.nextRunAt);
    return { items };
  }

  cancelSchedule(scheduleId: string): CancelScheduleResponse {
    const state = this.states.get(scheduleId);
    if (!state) {
      return {
        scheduleId,
        cancelled: false,
      };
    }

    this.clearTimer(state);
    this.states.delete(scheduleId);
    return {
      scheduleId,
      cancelled: true,
    };
  }

  dispose(): void {
    for (const state of this.states.values()) {
      this.clearTimer(state);
    }
    this.states.clear();
  }

  private clearTimer(state: ScheduledTaskState): void {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  private armTimer(scheduleId: string): void {
    const state = this.states.get(scheduleId);
    if (!state) {
      return;
    }

    this.clearTimer(state);

    const now = this.now();
    const delayMs = Math.max(0, state.record.nextRunAt - now);
    const waitMs = Math.min(delayMs, MAX_SET_TIMEOUT_MS);

    state.timer = setTimeout(() => {
      void this.onTimer(scheduleId);
    }, waitMs);
    const timer = state.timer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private async onTimer(scheduleId: string): Promise<void> {
    const state = this.states.get(scheduleId);
    if (!state) {
      return;
    }

    const now = this.now();
    if (now < state.record.nextRunAt) {
      this.armTimer(scheduleId);
      return;
    }

    const plannedAt = state.record.nextRunAt;
    try {
      await this.args.onTrigger({
        record: { ...state.record },
        plannedAt,
      });
    } catch (error) {
      this.logger.warn(
        `[scheduler] trigger failed for ${scheduleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (state.record.trigger.mode !== "cron") {
      this.cancelSchedule(scheduleId);
      return;
    }

    const nextRunAt = computeFollowingCronRunAt(state.record.trigger, now);
    state.record = {
      ...state.record,
      nextRunAt,
      updatedAt: this.now(),
    };
    this.states.set(scheduleId, state);
    this.armTimer(scheduleId);
  }
}

export const __scheduledTaskManagerInternals = {
  computeInitialNextRunAt,
  computeFollowingCronRunAt,
};
