import type { ToolSet } from "ai";
import type { AgentToolsPermission } from "../../../types/agent";
import type {
  CancelScheduleResponse,
  CreateScheduleRequest,
  CreateScheduleResponse,
  ListSchedulesResponse,
} from "../../../types/schedule";
import type { TaskExecutionStopReason } from "../../../types/task";
import type { AgentOutputMessageSink } from "../core/output_messages";
import type { PersistentMemoryCoordinator } from "../memory/persistent_coordinator";

export const BUILTIN_TOOL_NAMES = [
  "ls",
  "read",
  "tree",
  "ripgrep",
  "write",
  "todo_list",
  "todo_add",
  "todo_update",
  "todo_complete",
  "todo_reopen",
  "todo_remove",
  "todo_clear_done",
  "memory_write",
  "memory_search",
  "memory_get",
  "memory_update",
  "memory_delete",
  "memory_feedback",
  "memory_tag_resolve",
  "memory_compact",
  "memory_list_recent",
  "cp",
  "mv",
  "git",
  "bash",
  "background",
  "webfetch",
  "schedule",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export type ToolPermissionSource = {
  permissions?: AgentToolsPermission;
};

export type ToolBudgetConsumeResult =
  | {
      ok: true;
      used: number;
      remaining: number;
      limit: number;
      toolName: string;
    }
  | {
      ok: false;
      used: number;
      remaining: number;
      limit: number;
      toolName: string;
    };

export type ToolBudgetController = {
  tryConsume: (toolName: string) => ToolBudgetConsumeResult;
};

export type ToolExecutionSettledEvent = {
  toolName: string;
  input: unknown;
  ok: boolean;
  result?: unknown;
  error?: unknown;
};

export type ToolExecutionGuardDecision =
  | {
      allow: true;
    }
  | {
      allow: false;
      reason: string;
      stopReason?: TaskExecutionStopReason;
    };

export type ToolExecutionGuardEvent = {
  toolName: string;
  input: unknown;
  toolCallId?: string;
};

export type ToolExecutionContext = {
  permissions?: ToolPermissionSource;
  workspace?: string;
  persistentMemoryCoordinator?: PersistentMemoryCoordinator;
  scheduleGateway?: {
    createSchedule: (request: CreateScheduleRequest) => Promise<CreateScheduleResponse> | CreateScheduleResponse;
    listSchedules: () => Promise<ListSchedulesResponse> | ListSchedulesResponse;
    cancelSchedule: (scheduleId: string) => Promise<CancelScheduleResponse> | CancelScheduleResponse;
  };
  onOutputMessage?: AgentOutputMessageSink;
  toolBudget?: ToolBudgetController;
  beforeToolExecution?: (event: ToolExecutionGuardEvent) => ToolExecutionGuardDecision | Promise<ToolExecutionGuardDecision>;
  toolOutputMessageSource?: "registry" | "sdk_hooks";
  onToolExecutionSettled?: (event: ToolExecutionSettledEvent) => void | Promise<void>;
};

export type ToolDefinition = ToolSet[string];

export type ToolDefinitionMap = ToolSet;

export type ToolFactory<TContext extends ToolExecutionContext = ToolExecutionContext> = (
  context: TContext,
) => ToolDefinition;

export class ToolBudgetExceededError extends Error {
  readonly toolName: string;
  readonly used: number;
  readonly remaining: number;
  readonly limit: number;

  constructor(args: {
    toolName: string;
    used: number;
    remaining: number;
    limit: number;
  }) {
    super(
      `Tool budget exceeded before executing "${args.toolName}" (${args.used}/${args.limit} used)`,
    );
    this.name = "ToolBudgetExceededError";
    this.toolName = args.toolName;
    this.used = args.used;
    this.remaining = args.remaining;
    this.limit = args.limit;
  }
}

export class ToolPolicyBlockedError extends Error {
  readonly toolName: string;
  readonly stopReason: TaskExecutionStopReason;

  constructor(args: {
    toolName: string;
    reason: string;
    stopReason?: TaskExecutionStopReason;
  }) {
    super(args.reason);
    this.name = "ToolPolicyBlockedError";
    this.toolName = args.toolName;
    this.stopReason = args.stopReason ?? "tool_policy_blocked";
  }
}
