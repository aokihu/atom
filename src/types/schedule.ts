import type { TaskPriority } from "./task";

export type ScheduleTrigger =
  | {
      mode: "delay";
      delaySeconds: number;
    }
  | {
      mode: "at";
      runAt: string;
    }
  | {
      mode: "cron";
      cron: string;
      timezone: "UTC";
    };

export type CreateScheduleRequest = {
  dedupeKey: string;
  taskInput: string;
  taskType?: string;
  priority?: TaskPriority;
  trigger: ScheduleTrigger;
};

export type ScheduledTaskRecord = {
  scheduleId: string;
  dedupeKey: string;
  taskInput: string;
  taskType: string;
  priority: TaskPriority;
  trigger: ScheduleTrigger;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
};

export type CreateScheduleResponse = {
  schedule: ScheduledTaskRecord;
};

export type ListSchedulesResponse = {
  items: ScheduledTaskRecord[];
};

export type CancelScheduleResponse = {
  scheduleId: string;
  cancelled: boolean;
};
