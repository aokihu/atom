import { bashTool } from "./bash";
import { backgroundTool } from "./background";
import { cpTool } from "./cp";
import { gitTool } from "./git";
import { lsTool } from "./ls";
import { mvTool } from "./mv";
import { readTool } from "./read";
import { ripgrepTool } from "./ripgrep";
import { treeTool } from "./tree";
import {
  todoAddTool,
  todoClearDoneTool,
  todoCompleteTool,
  todoListTool,
  todoRemoveTool,
  todoReopenTool,
  todoUpdateTool,
} from "./todo_tools";
import { webfetchTool } from "./webfetch";
import { writeTool } from "./write";
import {
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  type ToolDefinitionMap,
  type ToolExecutionContext,
  type ToolFactory,
  ToolBudgetExceededError,
} from "./types";
import { emitOutputMessage, summarizeOutputValue, toOutputErrorMessage } from "../core/output_messages";
import { buildToolCallDisplay, buildToolResultDisplay } from "./tool_display";
import { getToolErrorMessageFromOutput } from "./tool_output_error";

const BUILTIN_TOOL_FACTORIES: Record<BuiltinToolName, ToolFactory> = {
  ls: lsTool,
  read: readTool,
  tree: treeTool,
  ripgrep: ripgrepTool,
  write: writeTool,
  todo_list: todoListTool,
  todo_add: todoAddTool,
  todo_update: todoUpdateTool,
  todo_complete: todoCompleteTool,
  todo_reopen: todoReopenTool,
  todo_remove: todoRemoveTool,
  todo_clear_done: todoClearDoneTool,
  cp: cpTool,
  mv: mvTool,
  git: gitTool,
  bash: bashTool,
  background: backgroundTool,
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
      const emitToolMessages = context.toolOutputMessageSource !== "sdk_hooks";
      const toolCallId = getToolCallId(args);
      const input = args[0];
      const emitToolSettled = async (event: {
        ok: boolean;
        result?: unknown;
        error?: unknown;
      }) => {
        try {
          await context.onToolExecutionSettled?.({
            toolName,
            input,
            ok: event.ok,
            result: event.result,
            error: event.error,
          });
        } catch {
          // Context sync hooks must not break tool execution.
        }
      };
      const budgetResult = context.toolBudget?.tryConsume(toolName);
      if (budgetResult && !budgetResult.ok) {
        throw new ToolBudgetExceededError({
          toolName,
          used: budgetResult.used,
          remaining: budgetResult.remaining,
          limit: budgetResult.limit,
        });
      }

      if (emitToolMessages) {
        emitOutputMessage(context.onOutputMessage, {
          category: "tool",
          type: "tool.call",
          toolName,
          toolCallId,
          inputSummary: summarizeOutputValue(input),
          inputDisplay: buildToolCallDisplay(toolName, input),
        });
      }

      try {
        const result = await execute.apply(definition, args);
        const errorMessage = getToolErrorMessageFromOutput(result);
        await emitToolSettled({
          ok: errorMessage === undefined,
          result,
          ...(errorMessage ? { error: errorMessage } : {}),
        });

        if (emitToolMessages) {
          emitOutputMessage(context.onOutputMessage, {
            category: "tool",
            type: "tool.result",
            toolName,
            toolCallId,
            ok: errorMessage === undefined,
            outputSummary: summarizeOutputValue(result),
            errorMessage,
            outputDisplay: buildToolResultDisplay(toolName, input, result, errorMessage),
          });
        }

        return result;
      } catch (error) {
        await emitToolSettled({
          ok: false,
          error,
        });
        if (emitToolMessages) {
          emitOutputMessage(context.onOutputMessage, {
            category: "tool",
            type: "tool.result",
            toolName,
            toolCallId,
            ok: false,
            errorMessage: toOutputErrorMessage(error),
            outputDisplay: buildToolResultDisplay(toolName, input, {
              error: toOutputErrorMessage(error),
            }, toOutputErrorMessage(error)),
          });
        }

        throw error;
      }
    },
  } as ToolDefinitionMap[string];
};

const wrapToolRegistryWithOutput = (
  registry: ToolDefinitionMap,
  context: ToolExecutionContext,
): ToolDefinitionMap => {
  const emitsToolMessages =
    context.toolOutputMessageSource !== "sdk_hooks" && context.onOutputMessage !== undefined;

  if (!emitsToolMessages && !context.toolBudget && !context.onToolExecutionSettled) {
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
