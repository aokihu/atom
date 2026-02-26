import type { ToolSet } from "ai";
import type { AgentToolsPermission } from "../../../types/agent";
import type { AgentOutputMessageSink } from "../core/output_messages";

export const BUILTIN_TOOL_NAMES = [
  "ls",
  "read",
  "tree",
  "ripgrep",
  "write",
  "todo",
  "cp",
  "mv",
  "git",
  "bash",
  "background",
  "webfetch",
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

export type ToolExecutionContext = {
  permissions?: ToolPermissionSource;
  workspace?: string;
  onOutputMessage?: AgentOutputMessageSink;
  toolBudget?: ToolBudgetController;
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
