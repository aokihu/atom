import {
  createBuiltinToolRegistry,
  createToolRegistry,
} from "./registry";
import type { ToolDefinitionMap, ToolExecutionContext } from "./types";

export type {
  ToolBudgetController,
  ToolDefinitionMap,
  ToolExecutionContext,
  ToolExecutionSettledEvent,
} from "./types";
export { BUILTIN_TOOL_NAMES } from "./types";
export { ToolBudgetExceededError } from "./types";
export { createBuiltinToolRegistry, createToolRegistry } from "./registry";

export default (context: ToolExecutionContext): ToolDefinitionMap =>
  createBuiltinToolRegistry(context);
