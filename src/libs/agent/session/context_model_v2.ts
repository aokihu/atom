import type {
  AgentContext,
  AgentContextMemory,
  ModelContextV2,
  ModelContextV2ActiveTaskMeta,
  ModelContextV2Todo,
} from "../../../types/agent";

const cloneMemory = (memory: AgentContextMemory): AgentContextMemory => ({
  core: structuredClone(memory.core),
  working: structuredClone(memory.working),
  ephemeral: structuredClone(memory.ephemeral),
  longterm: structuredClone(memory.longterm),
});

const toTodo = (context: AgentContext): ModelContextV2Todo | undefined => {
  const raw = context.todo;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const todo = raw as Record<string, unknown>;
  const next: ModelContextV2Todo = {};

  if (typeof todo.summary === "string") {
    next.summary = todo.summary;
  }
  if (typeof todo.total === "number" && Number.isFinite(todo.total)) {
    next.total = todo.total;
  }
  if (typeof todo.step === "number" && Number.isFinite(todo.step)) {
    next.step = todo.step;
  }
  if (typeof todo.cursor === "number" && Number.isFinite(todo.cursor)) {
    next.cursor = todo.cursor;
  }

  return Object.keys(next).length > 0 ? next : undefined;
};

const toActiveTaskMeta = (context: AgentContext): ModelContextV2ActiveTaskMeta | null | undefined => {
  const raw = context.active_task_meta;
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const meta = raw as Record<string, unknown>;
  const next: ModelContextV2ActiveTaskMeta = {};

  if (typeof meta.id === "string") next.id = meta.id;
  if (typeof meta.type === "string") next.type = meta.type;
  if (typeof meta.status === "string") next.status = meta.status;
  if (typeof meta.retries === "number" && Number.isInteger(meta.retries)) next.retries = meta.retries;
  if (typeof meta.attempt === "number" && Number.isInteger(meta.attempt)) next.attempt = meta.attempt;
  if (meta.execution && typeof meta.execution === "object" && !Array.isArray(meta.execution)) {
    next.execution = structuredClone(meta.execution as Record<string, unknown>);
  }

  return Object.keys(next).length > 0 ? next : undefined;
};

export const toModelContextV2 = (context: AgentContext): ModelContextV2 => {
  const modelContext: ModelContextV2 = {
    version: context.version,
    runtime: {
      round: context.runtime.round,
      workspace: context.runtime.workspace,
      datetime: context.runtime.datetime,
      startup_at: context.runtime.startup_at,
    },
    memory: cloneMemory(context.memory),
  };

  const todo = toTodo(context);
  if (todo) {
    modelContext.todo = todo;
  }

  if (typeof context.active_task === "string" || context.active_task === null) {
    modelContext.active_task = context.active_task;
  }

  const activeTaskMeta = toActiveTaskMeta(context);
  if (activeTaskMeta !== undefined) {
    modelContext.active_task_meta = activeTaskMeta;
  }

  if (context.capabilities !== undefined) {
    modelContext.capabilities = structuredClone(context.capabilities);
  }

  return modelContext;
};
