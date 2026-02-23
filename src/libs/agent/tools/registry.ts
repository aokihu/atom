import { lsTool } from "./ls";
import { readTool } from "./read";
import { ripgrepTool } from "./ripgrep";
import { treeTool } from "./tree";
import { webfetchTool } from "./webfetch";
import { writeTool } from "./write";
import {
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  type ToolDefinitionMap,
  type ToolExecutionContext,
  type ToolFactory,
} from "./types";

const BUILTIN_TOOL_FACTORIES: Record<BuiltinToolName, ToolFactory> = {
  ls: lsTool,
  read: readTool,
  tree: treeTool,
  ripgrep: ripgrepTool,
  write: writeTool,
  webfetch: webfetchTool,
};

export const createBuiltinToolRegistry = (
  context: ToolExecutionContext,
): ToolDefinitionMap => {
  const registry: ToolDefinitionMap = {};

  for (const toolName of BUILTIN_TOOL_NAMES) {
    registry[toolName] = BUILTIN_TOOL_FACTORIES[toolName](context);
  }

  return registry;
};

type CreateToolRegistryOptions = {
  context: ToolExecutionContext;
  mcpTools?: ToolDefinitionMap;
};

export const createToolRegistry = ({
  context,
  mcpTools = {},
}: CreateToolRegistryOptions): ToolDefinitionMap => {
  const builtinTools = createBuiltinToolRegistry(context);

  for (const toolName of Object.keys(mcpTools)) {
    if (toolName in builtinTools) {
      throw new Error(`Tool name conflict: ${toolName}`);
    }
  }

  return {
    ...mcpTools,
    ...builtinTools,
  };
};

