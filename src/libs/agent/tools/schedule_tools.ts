import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutionContext } from "./types";

const scheduleInputSchema = z.object({
  action: z.enum(["create", "list", "cancel"]),
  dedupeKey: z.string().optional(),
  taskInput: z.string().optional(),
  taskType: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  scheduleId: z.string().optional(),
  trigger: z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("delay"),
        delaySeconds: z.number().positive(),
      }),
      z.object({
        mode: z.literal("at"),
        runAt: z.string().min(1),
      }),
      z.object({
        mode: z.literal("cron"),
        cron: z.string().min(1),
        timezone: z.literal("UTC").optional(),
      }),
    ])
    .optional(),
}).strict();

type ScheduleToolInput = z.infer<typeof scheduleInputSchema>;

const invalidInput = (error: string, detail?: string) => ({
  error,
  ...(detail ? { detail } : {}),
});

const formatZodInputError = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Invalid input";

const validateCreateInput = (input: ScheduleToolInput) => {
  if (!input.dedupeKey || input.dedupeKey.trim() === "") {
    return invalidInput("Invalid schedule input", "dedupeKey is required for create");
  }
  if (!input.taskInput || input.taskInput.trim() === "") {
    return invalidInput("Invalid schedule input", "taskInput is required for create");
  }
  if (!input.trigger) {
    return invalidInput("Invalid schedule input", "trigger is required for create");
  }
  return null;
};

const validateCancelInput = (input: ScheduleToolInput) => {
  if (!input.scheduleId || input.scheduleId.trim() === "") {
    return invalidInput("Invalid schedule input", "scheduleId is required for cancel");
  }
  return null;
};

export const scheduleTool = (context: ToolExecutionContext) =>
  tool({
    description: "Manage internal scheduled tasks (create/list/cancel) without external CLI",
    inputSchema: scheduleInputSchema,
    execute: async (input: ScheduleToolInput) => {
      const parsed = scheduleInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid schedule input", formatZodInputError(parsed.error));
      }

      const gateway = context.scheduleGateway;
      if (!gateway) {
        return {
          error: "Schedule API unavailable: runtime does not provide schedule gateway",
        };
      }

      if (parsed.data.action === "list") {
        try {
          const result = await gateway.listSchedules();
          return {
            success: true,
            count: result.items.length,
            items: result.items,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "schedule list failed",
          };
        }
      }

      if (parsed.data.action === "cancel") {
        const validation = validateCancelInput(parsed.data);
        if (validation) {
          return validation;
        }
        try {
          const result = await gateway.cancelSchedule(parsed.data.scheduleId!);
          return {
            success: true,
            ...result,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "schedule cancel failed",
          };
        }
      }

      const validation = validateCreateInput(parsed.data);
      if (validation) {
        return validation;
      }

      const trigger =
        parsed.data.trigger?.mode === "cron"
          ? {
              ...parsed.data.trigger,
              timezone: "UTC" as const,
            }
          : parsed.data.trigger!;

      try {
        const priority = parsed.data.priority;
        const result = await gateway.createSchedule({
          dedupeKey: parsed.data.dedupeKey!,
          taskInput: parsed.data.taskInput!,
          ...(parsed.data.taskType ? { taskType: parsed.data.taskType } : {}),
          ...(typeof priority === "number" ? { priority: priority as 0 | 1 | 2 | 3 | 4 } : {}),
          trigger,
        });

        return {
          success: true,
          schedule: result.schedule,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "schedule create failed",
        };
      }
    },
  });
