import { Database } from "bun:sqlite";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import {
  MAX_TODO_LIST_LIMIT,
  addTodoItem,
  appendTodoEvent,
  clearDoneTodoItems,
  getTodoDbPath,
  getTodoItemById,
  getTodoProgressContext,
  listTodoItems,
  openTodoDatabase,
  removeTodoItem,
  setTodoItemDone,
  updateTodoItem,
  type TodoEventPayload,
  type TodoEventType,
} from "./todo_store";
import type { ToolExecutionContext } from "./types";

const listInputSchema = z.object({
  status: z.enum(["all", "open", "done"]).optional(),
  limit: z.number().int().positive().max(MAX_TODO_LIST_LIMIT).optional(),
}).strict();

const addInputSchema = z.object({
  title: z.string(),
  note: z.string().optional(),
}).strict();

const updateInputSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().optional(),
  note: z.string().optional(),
}).strict();

const idInputSchema = z.object({
  id: z.number().int().positive(),
}).strict();

const clearDoneInputSchema = z.object({}).strict();

type ListInput = z.infer<typeof listInputSchema>;
type AddInput = z.infer<typeof addInputSchema>;
type UpdateInput = z.infer<typeof updateInputSchema>;
type IdInput = z.infer<typeof idInputSchema>;
type ClearDoneInput = z.infer<typeof clearDoneInputSchema>;

const invalidInput = (error: string, detail?: string) => ({
  error,
  ...(detail ? { detail } : {}),
});

const formatZodInputError = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Invalid input";

const normalizeTitle = (title: string) => {
  const normalized = title.trim();
  if (!normalized) {
    return { error: "Invalid title", detail: "title must be a non-empty string" } as const;
  }
  return { title: normalized } as const;
};

const getWorkspaceFromContext = (context: ToolExecutionContext) => {
  const workspace = typeof context.workspace === "string" ? context.workspace.trim() : "";
  if (!workspace) {
    return { error: "Workspace unavailable: todo tools require context.workspace" } as const;
  }
  return { workspace } as const;
};

const withAuthorizedTodoDb = async <T>(
  context: ToolExecutionContext,
  fn: (db: Database) => Promise<T> | T,
) => {
  const workspaceResult = getWorkspaceFromContext(context);
  if ("error" in workspaceResult) {
    return workspaceResult;
  }

  const dbPath = getTodoDbPath(workspaceResult.workspace);
  if (!createPermissionPolicy(context).canUseTodo(dbPath)) {
    return { error: "Permission denied: todo path not allowed" } as const;
  }

  let db: Database | null = null;
  try {
    db = await openTodoDatabase(workspaceResult.workspace);
    return await fn(db);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "todo tool failed",
    } as const;
  } finally {
    db?.close();
  }
};

const runInTransaction = <T>(db: Database, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors to preserve original error
    }
    throw error;
  }
};

const createEventPayload = (args: {
  input: Record<string, unknown>;
  before?: TodoEventPayload["before"];
  after?: TodoEventPayload["after"];
  removedItems?: NonNullable<TodoEventPayload["removedItems"]>;
  progress: TodoEventPayload["progress"];
}): TodoEventPayload => ({
  v: 1,
  input: args.input,
  before: args.before ?? null,
  after: args.after ?? null,
  removedItems: args.removedItems ?? [],
  progress: args.progress,
});

const appendAgentTodoEvent = (
  db: Database,
  args: {
    todoId?: number | null;
    eventType: TodoEventType;
    toolName: string;
    payload: TodoEventPayload;
  },
) => {
  appendTodoEvent(db, {
    todoId: args.todoId ?? null,
    eventType: args.eventType,
    actor: "agent",
    toolName: args.toolName,
    payload: args.payload,
  });
};

export const todoListTool = (context: ToolExecutionContext) =>
  tool({
    description: "List workspace TODO items from the internal SQLite TODO store",
    inputSchema: listInputSchema,
    execute: async (input: ListInput) => {
      const parsed = listInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid todo_list input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedTodoDb(context, (db) => {
        const items = listTodoItems(db, {
          status: parsed.data.status ?? "all",
          limit: parsed.data.limit,
        });
        const todo = getTodoProgressContext(db);
        return {
          success: true,
          count: items.length,
          items,
          todo,
        };
      });
    },
  });

export const todoAddTool = (context: ToolExecutionContext) =>
  tool({
    description: "Add a TODO item to the workspace internal SQLite TODO store",
    inputSchema: addInputSchema,
    execute: async (input: AddInput) => {
      const parsed = addInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid todo_add input", formatZodInputError(parsed.error));
      }

      const titleResult = normalizeTitle(parsed.data.title);
      if ("error" in titleResult) {
        return titleResult;
      }

      return await withAuthorizedTodoDb(context, (db) => runInTransaction(db, () => {
        const normalizedInput = {
          title: titleResult.title,
          note: parsed.data.note ?? "",
        };
        const item = addTodoItem(db, normalizedInput);
        if (!item) {
          return { error: "todo_add failed: inserted item not found" };
        }
        const todo = getTodoProgressContext(db);
        appendAgentTodoEvent(db, {
          eventType: "add",
          todoId: item.id,
          toolName: "todo_add",
          payload: createEventPayload({
            input: normalizedInput,
            before: null,
            after: item,
            progress: todo,
          }),
        });
        return {
          success: true,
          item,
          todo,
        };
      }));
    },
  });

export const todoUpdateTool = (context: ToolExecutionContext) =>
  tool({
    description: "Update a TODO item title and/or note in the workspace TODO store",
    inputSchema: updateInputSchema,
    execute: async (input: UpdateInput) => {
      const parsed = updateInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid todo_update input", formatZodInputError(parsed.error));
      }

      const { id, note } = parsed.data;
      let title: string | undefined;
      if (parsed.data.title !== undefined) {
        const titleResult = normalizeTitle(parsed.data.title);
        if ("error" in titleResult) {
          return titleResult;
        }
        title = titleResult.title;
      }

      if (title === undefined && note === undefined) {
        return invalidInput("Invalid todo_update input", "At least one of title or note is required");
      }

      return await withAuthorizedTodoDb(context, (db) => runInTransaction(db, () => {
        const before = getTodoItemById(db, id);
        if (!before) {
          return { error: "Todo item not found", id };
        }

        const item = updateTodoItem(db, { id, title, note });
        if (!item) {
          return { error: "Todo item not found", id };
        }
        const todo = getTodoProgressContext(db);
        appendAgentTodoEvent(db, {
          eventType: "update",
          todoId: id,
          toolName: "todo_update",
          payload: createEventPayload({
            input: {
              id,
              ...(title !== undefined ? { title } : {}),
              ...(note !== undefined ? { note } : {}),
            },
            before,
            after: item,
            progress: todo,
          }),
        });
        return {
          success: true,
          item,
          todo,
        };
      }));
    },
  });

const createTodoStatusTool = (
  context: ToolExecutionContext,
  args: {
    name: "todo_complete" | "todo_reopen";
    done: boolean;
    description: string;
    eventType: "complete" | "reopen";
  },
) =>
  tool({
    description: args.description,
    inputSchema: idInputSchema,
    execute: async (input: IdInput) => {
      const parsed = idInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput(`Invalid ${args.name} input`, formatZodInputError(parsed.error));
      }

      return await withAuthorizedTodoDb(context, (db) => runInTransaction(db, () => {
        const before = getTodoItemById(db, parsed.data.id);
        if (!before) {
          return { error: "Todo item not found", id: parsed.data.id };
        }

        const item = setTodoItemDone(db, { id: parsed.data.id, done: args.done });
        if (!item) {
          return { error: "Todo item not found", id: parsed.data.id };
        }
        const todo = getTodoProgressContext(db);
        appendAgentTodoEvent(db, {
          eventType: args.eventType,
          todoId: parsed.data.id,
          toolName: args.name,
          payload: createEventPayload({
            input: { id: parsed.data.id },
            before,
            after: item,
            progress: todo,
          }),
        });
        return {
          success: true,
          item,
          todo,
        };
      }));
    },
  });

export const todoCompleteTool = (context: ToolExecutionContext) =>
  createTodoStatusTool(context, {
    name: "todo_complete",
    done: true,
    description: "Mark a TODO item as completed",
    eventType: "complete",
  });

export const todoReopenTool = (context: ToolExecutionContext) =>
  createTodoStatusTool(context, {
    name: "todo_reopen",
    done: false,
    description: "Reopen a completed TODO item",
    eventType: "reopen",
  });

export const todoRemoveTool = (context: ToolExecutionContext) =>
  tool({
    description: "Remove a TODO item from the workspace TODO store",
    inputSchema: idInputSchema,
    execute: async (input: IdInput) => {
      const parsed = idInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid todo_remove input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedTodoDb(context, (db) => runInTransaction(db, () => {
        const result = removeTodoItem(db, parsed.data.id);
        if (!result.removed || !result.item) {
          return { error: "Todo item not found", id: parsed.data.id };
        }
        const todo = getTodoProgressContext(db);
        appendAgentTodoEvent(db, {
          eventType: "remove",
          todoId: parsed.data.id,
          toolName: "todo_remove",
          payload: createEventPayload({
            input: { id: parsed.data.id },
            before: result.item,
            after: null,
            progress: todo,
          }),
        });
        return {
          success: true,
          id: parsed.data.id,
          todo,
        };
      }));
    },
  });

export const todoClearDoneTool = (context: ToolExecutionContext) =>
  tool({
    description: "Delete all completed TODO items from the workspace TODO store",
    inputSchema: clearDoneInputSchema,
    execute: async (input: ClearDoneInput) => {
      const parsed = clearDoneInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid todo_clear_done input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedTodoDb(context, (db) => runInTransaction(db, () => {
        const result = clearDoneTodoItems(db);
        const todo = getTodoProgressContext(db);
        appendAgentTodoEvent(db, {
          eventType: "clear_done",
          todoId: null,
          toolName: "todo_clear_done",
          payload: createEventPayload({
            input: {},
            before: null,
            after: null,
            removedItems: result.removedItems,
            progress: todo,
          }),
        });
        return {
          success: true,
          deletedCount: result.deletedCount,
          todo,
        };
      }));
    },
  });
