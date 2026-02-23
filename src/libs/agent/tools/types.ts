import type { ToolSet } from "ai";
import type { AgentToolsConfig } from "../../../types/agent";

export const BUILTIN_TOOL_NAMES = [
  "ls",
  "read",
  "tree",
  "ripgrep",
  "write",
  "webfetch",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export type ToolPermissionSource = {
  tools?: AgentToolsConfig;
};

export type ToolExecutionContext = {
  permissions?: ToolPermissionSource;
};

export type ToolDefinition = ToolSet[string];

export type ToolDefinitionMap = ToolSet;

export type ToolFactory<TContext extends ToolExecutionContext = ToolExecutionContext> = (
  context: TContext,
) => ToolDefinition;
