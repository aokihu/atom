import type {
  AgentContext,
  AgentContextTodoProgress,
  ModelContextV2,
  ModelContextV2ActiveTaskMeta,
} from "../../../types/agent";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toModelRuntime = (runtime: AgentContext["runtime"]): ModelContextV2["runtime"] => ({
  round: runtime.round,
  workspace: runtime.workspace,
  datetime: runtime.datetime,
  startup_at: runtime.startup_at,
});

const toModelTodo = (value: unknown): AgentContextTodoProgress | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const summary = typeof value.summary === "string" ? value.summary : undefined;
  const total = typeof value.total === "number" && Number.isFinite(value.total)
    ? Math.max(0, Math.trunc(value.total))
    : undefined;
  const step = typeof value.step === "number" && Number.isFinite(value.step)
    ? Math.max(0, Math.trunc(value.step))
    : undefined;

  if (summary === undefined || total === undefined || step === undefined) {
    return undefined;
  }

  const todo: AgentContextTodoProgress = {
    summary,
    total,
    step: Math.min(step, total),
  };

  if (value.cursor !== undefined) {
    todo.cursor = structuredClone(value.cursor as AgentContextTodoProgress["cursor"]);
  }

  return todo;
};

const toModelActiveTaskMeta = (value: unknown): ModelContextV2ActiveTaskMeta | null | undefined => {
  if (value === null) {
    return null;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const meta: ModelContextV2ActiveTaskMeta = {};
  if (typeof value.id === "string") meta.id = value.id;
  if (typeof value.type === "string") meta.type = value.type;
  if (typeof value.status === "string") meta.status = value.status;
  if (typeof value.retries === "number" && Number.isFinite(value.retries)) {
    meta.retries = Math.max(0, Math.trunc(value.retries));
  }
  if (typeof value.attempt === "number" && Number.isFinite(value.attempt)) {
    meta.attempt = Math.max(0, Math.trunc(value.attempt));
  }
  if (isPlainObject(value.execution)) {
    meta.execution = structuredClone(value.execution);
  }

  return meta;
};

export const toModelContextV2 = (context: AgentContext): ModelContextV2 => {
  const record = context as Record<string, unknown>;
  const modelContext: ModelContextV2 = {
    version: context.version,
    runtime: toModelRuntime(context.runtime),
    memory: structuredClone(context.memory),
  };

  const todo = toModelTodo(record.todo);
  if (todo) {
    modelContext.todo = todo;
  }

  if (record.active_task !== undefined) {
    modelContext.active_task = structuredClone(record.active_task);
  }

  const activeTaskMeta = toModelActiveTaskMeta(record.active_task_meta);
  if (activeTaskMeta !== undefined) {
    modelContext.active_task_meta = activeTaskMeta;
  }

  if (record.capabilities !== undefined) {
    modelContext.capabilities = structuredClone(record.capabilities);
  }

  return modelContext;
};
