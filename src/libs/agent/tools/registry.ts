import { bashTool } from "./bash";
import { cpTool } from "./cp";
import { gitTool } from "./git";
import { lsTool } from "./ls";
import { mvTool } from "./mv";
import { readTool } from "./read";
import { ripgrepTool } from "./ripgrep";
import { treeTool } from "./tree";
import { todoTool } from "./todo";
import { webfetchTool } from "./webfetch";
import { writeTool } from "./write";
import {
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  type ToolDefinitionMap,
  type ToolExecutionContext,
  type ToolFactory,
} from "./types";
import { emitOutputMessage, summarizeOutputValue, toOutputErrorMessage } from "../core/output_messages";

const BUILTIN_TOOL_FACTORIES: Record<BuiltinToolName, ToolFactory> = {
  ls: lsTool,
  read: readTool,
  tree: treeTool,
  ripgrep: ripgrepTool,
  write: writeTool,
  todo: todoTool,
  cp: cpTool,
  mv: mvTool,
  git: gitTool,
  bash: bashTool,
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

const getToolCallId = (args: unknown[]): string | undefined => {
  const metadata = args[1];
  if (!metadata || typeof metadata !== "object") return undefined;

  const value = (metadata as Record<string, unknown>).toolCallId;
  return typeof value === "string" ? value : undefined;
};

const getToolErrorMessage = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;

  const error = (result as Record<string, unknown>).error;
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }

  if (error !== undefined) {
    return summarizeOutputValue(error);
  }

  return undefined;
};

const wrapToolDefinition = (
  toolName: string,
  definition: ToolDefinitionMap[string],
  context: ToolExecutionContext,
): ToolDefinitionMap[string] => {
  const execute = (definition as any)?.execute;
  if (typeof execute !== "function") {
    return definition;
  }

  return {
    ...(definition as Record<string, unknown>),
    execute: async (...args: unknown[]) => {
      const toolCallId = getToolCallId(args);
      emitOutputMessage(context.onOutputMessage, {
        category: "tool",
        type: "tool.call",
        toolName,
        toolCallId,
        inputSummary: summarizeOutputValue(args[0]),
      });

      try {
        const result = await execute.apply(definition, args);
        const errorMessage = getToolErrorMessage(result);

        emitOutputMessage(context.onOutputMessage, {
          category: "tool",
          type: "tool.result",
          toolName,
          toolCallId,
          ok: errorMessage === undefined,
          outputSummary: summarizeOutputValue(result),
          errorMessage,
        });

        return result;
      } catch (error) {
        emitOutputMessage(context.onOutputMessage, {
          category: "tool",
          type: "tool.result",
          toolName,
          toolCallId,
          ok: false,
          errorMessage: toOutputErrorMessage(error),
        });

        throw error;
      }
    },
  } as ToolDefinitionMap[string];
};

const wrapToolRegistryWithOutput = (
  registry: ToolDefinitionMap,
  context: ToolExecutionContext,
): ToolDefinitionMap => {
  if (!context.onOutputMessage) {
    return registry;
  }

  const wrapped: ToolDefinitionMap = {};
  for (const [toolName, definition] of Object.entries(registry)) {
    wrapped[toolName] = wrapToolDefinition(toolName, definition, context);
  }

  return wrapped;
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

  const mergedRegistry: ToolDefinitionMap = {
    ...mcpTools,
    ...builtinTools,
  };

  return wrapToolRegistryWithOutput(mergedRegistry, context);
};
