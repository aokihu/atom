import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryScheduledTaskManager,
  __scheduledTaskManagerInternals,
} from "./scheduled_task_manager";
import { SqliteScheduledTaskStore } from "./scheduled_task_store";

const waitUntil = async (check: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timeout");
    }
    await Bun.sleep(1);
  }
};

describe("InMemoryScheduledTaskManager", () => {
  test("triggers delay schedules once", async () => {
    const triggers: string[] = [];
    const manager = new InMemoryScheduledTaskManager({
      onTrigger: ({ record }) => {
        triggers.push(record.scheduleId);
      },
    });

    const created = manager.createSchedule({
      dedupeKey: "job-delay",
      taskInput: "hello",
      trigger: {
        mode: "delay",
        delaySeconds: 0.02,
      },
    });

    await waitUntil(() => triggers.length === 1);
    expect(triggers).toEqual([created.schedule.scheduleId]);
    expect(manager.listSchedules().items).toHaveLength(0);
  });

  test("cancels scheduled task before it triggers", async () => {
    const triggers: string[] = [];
    const manager = new InMemoryScheduledTaskManager({
      onTrigger: ({ record }) => {
        triggers.push(record.scheduleId);
      },
    });

    const created = manager.createSchedule({
      dedupeKey: "job-cancel",
      taskInput: "hello",
      trigger: {
        mode: "delay",
        delaySeconds: 0.1,
      },
    });
    const cancelled = manager.cancelSchedule(created.schedule.scheduleId);
    expect(cancelled.cancelled).toBe(true);

    await Bun.sleep(150);
    expect(triggers).toEqual([]);
    expect(manager.listSchedules().items).toHaveLength(0);
  });

  test("supports at schedule mode", async () => {
    const triggers: string[] = [];
    const manager = new InMemoryScheduledTaskManager({
      onTrigger: ({ record }) => {
        triggers.push(record.scheduleId);
      },
    });

    const runAt = new Date(Date.now() + 40).toISOString();
    const created = manager.createSchedule({
      dedupeKey: "job-at",
      taskInput: "hello",
      trigger: {
        mode: "at",
        runAt,
      },
    });

    await waitUntil(() => triggers.length === 1);
    expect(triggers).toEqual([created.schedule.scheduleId]);
  });

  test("keeps cron schedules active and computes next run", () => {
    const now = Date.now();
    const nextRunAt = __scheduledTaskManagerInternals.computeInitialNextRunAt(
      {
        mode: "cron",
        cron: "*/5 * * * * *",
        timezone: "UTC",
      },
      now,
    );

    expect(nextRunAt).toBeGreaterThan(now);
  });

  test("restores persisted schedules after manager restart", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-scheduler-"));
    try {
      const first = new InMemoryScheduledTaskManager({
        onTrigger: () => {},
        persistence: new SqliteScheduledTaskStore(workspace, { warn() {} }),
      });
      const created = first.createSchedule({
        dedupeKey: "persist-restart",
        taskInput: "hello",
        trigger: {
          mode: "delay",
          delaySeconds: 60,
        },
      });
      first.dispose();

      const second = new InMemoryScheduledTaskManager({
        onTrigger: () => {},
        persistence: new SqliteScheduledTaskStore(workspace, { warn() {} }),
      });
      const listed = second.listSchedules();
      expect(listed.items.map((item) => item.scheduleId)).toEqual([created.schedule.scheduleId]);
      second.dispose();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists one-shot removal after trigger", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-scheduler-"));
    const triggers: string[] = [];
    try {
      const first = new InMemoryScheduledTaskManager({
        onTrigger: ({ record }) => {
          triggers.push(record.scheduleId);
        },
        persistence: new SqliteScheduledTaskStore(workspace, { warn() {} }),
      });
      first.createSchedule({
        dedupeKey: "persist-fired",
        taskInput: "hello",
        trigger: {
          mode: "delay",
          delaySeconds: 0.02,
        },
      });
      await waitUntil(() => triggers.length === 1);
      first.dispose();

      const second = new InMemoryScheduledTaskManager({
        onTrigger: () => {},
        persistence: new SqliteScheduledTaskStore(workspace, { warn() {} }),
      });
      expect(second.listSchedules().items).toHaveLength(0);
      second.dispose();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
