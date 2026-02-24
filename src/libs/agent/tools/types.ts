import type { ToolSet } from "ai";
import type { AgentToolsPermission } from "../../../types/agent";

export const BUILTIN_TOOL_NAMES = [
  "ls",
  "read",
  "tree",
  "ripgrep",
  "write",
  "cp",
  "mv",
  "git",
  "webfetch",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export type ToolPermissionSource = {
  permissions?: AgentToolsPermission;
};

export type ToolExecutionContext = {
  permissions?: ToolPermissionSource;
};

export type ToolDefinition = ToolSet[string];

export type ToolDefinitionMap = ToolSet;

export type ToolFactory<TContext extends ToolExecutionContext = ToolExecutionContext> = (
  context: TContext,
) => ToolDefinition;
