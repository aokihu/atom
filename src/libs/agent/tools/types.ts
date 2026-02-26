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

export type ToolExecutionContext = {
  permissions?: ToolPermissionSource;
  workspace?: string;
  onOutputMessage?: AgentOutputMessageSink;
};

export type ToolDefinition = ToolSet[string];

export type ToolDefinitionMap = ToolSet;

export type ToolFactory<TContext extends ToolExecutionContext = ToolExecutionContext> = (
  context: TContext,
) => ToolDefinition;
