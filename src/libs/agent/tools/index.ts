import {
  createBuiltinToolRegistry,
  createToolRegistry,
} from "./registry";
import type { ToolDefinitionMap, ToolExecutionContext } from "./types";

export type { ToolDefinitionMap, ToolExecutionContext } from "./types";
export { BUILTIN_TOOL_NAMES } from "./types";
export { createBuiltinToolRegistry, createToolRegistry } from "./registry";

export default (context: ToolExecutionContext): ToolDefinitionMap =>
  createBuiltinToolRegistry(context);
