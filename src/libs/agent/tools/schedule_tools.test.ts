import { describe, expect, test } from "bun:test";
import { scheduleTool } from "./schedule_tools";

describe("schedule tool", () => {
  test("creates/lists/cancels schedules via gateway", async () => {
    const calls: Array<{ action: string; payload?: unknown }> = [];
    const tool = scheduleTool({
      scheduleGateway: {
        createSchedule(request) {
          calls.push({ action: "create", payload: request });
          return {
            schedule: {
              scheduleId: "schedule-1",
              dedupeKey: request.dedupeKey,
              taskInput: request.taskInput,
              taskType: request.taskType ?? "scheduled.input",
              priority: request.priority ?? 2,
              trigger: request.trigger,
              nextRunAt: Date.now() + 1_000,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          };
        },
        listSchedules() {
          calls.push({ action: "list" });
          return {
            items: [],
          };
        },
        cancelSchedule(scheduleId) {
          calls.push({ action: "cancel", payload: scheduleId });
          return {
            scheduleId,
            cancelled: true,
          };
        },
      },
    }) as any;

    const created = await tool.execute({
      action: "create",
      dedupeKey: "demo",
      taskInput: "hello",
      trigger: {
        mode: "delay",
        delaySeconds: 10,
      },
    });
    expect(created.success).toBe(true);
    expect(created.schedule.scheduleId).toBe("schedule-1");

    const listed = await tool.execute({ action: "list" });
    expect(listed.success).toBe(true);
    expect(listed.count).toBe(0);

    const cancelled = await tool.execute({
      action: "cancel",
      scheduleId: "schedule-1",
    });
    expect(cancelled.success).toBe(true);
    expect(cancelled.cancelled).toBe(true);

    expect(calls.map((item) => item.action)).toEqual(["create", "list", "cancel"]);
  });

  test("returns validation error for missing create fields", async () => {
    const tool = scheduleTool({
      scheduleGateway: {
        createSchedule() {
          throw new Error("should not be called");
        },
        listSchedules() {
          throw new Error("should not be called");
        },
        cancelSchedule() {
          throw new Error("should not be called");
        },
      },
    }) as any;

    const result = await tool.execute({
      action: "create",
      dedupeKey: "demo",
    });
    expect(result.error).toBe("Invalid schedule input");
  });
});
