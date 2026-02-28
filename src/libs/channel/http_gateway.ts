import type { RuntimeGateway } from "./channel";
import type {
  AgentMemoryDeleteRequest,
  AgentMemoryFeedbackRequest,
  AgentMemoryGetRequest,
  AgentMemoryListRecentRequest,
  AgentMemorySearchRequest,
  AgentMemoryTagResolveRequest,
  AgentMemoryUpdateRequest,
  AgentMemoryUpsertRequest,
  ApiErrorCode,
  ApiErrorResponse,
  ApiSuccessResponse,
  CreateScheduleRequest,
  CreateTaskRequest,
  HealthzResponse,
  MessageGatewayHealthStatus,
  MCPHealthStatus,
  ScheduleTrigger,
} from "../../types/http";

type StartHttpGatewayOptions = {
  runtime: RuntimeGateway;
  host: string;
  port: number;
  appName: string;
  version: string;
  startupAt: number;
  getMcpStatus?: (options?: { probeHttp?: boolean }) => Promise<MCPHealthStatus> | MCPHealthStatus;
  getMessageGatewayStatus?:
    | (() => Promise<MessageGatewayHealthStatus> | MessageGatewayHealthStatus)
    | undefined;
};

export type HttpGatewayServer = {
  host: string;
  port: number;
  baseUrl: string;
  stop: () => void;
  raw: ReturnType<typeof Bun.serve>;
};

type ResponseHeaders = Record<string, string>;

class HttpApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpApiError";
  }
}

const json = (status: number, body: unknown, headers?: ResponseHeaders) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });

const ok = <T>(data: T, status = 200) =>
  json(status, {
    ok: true,
    data,
  } satisfies ApiSuccessResponse<T>);

const fail = (
  status: number,
  code: ApiErrorCode,
  message: string,
  headers?: ResponseHeaders,
) =>
  json(
    status,
    {
      ok: false,
      error: {
        code,
        message,
      },
    } satisfies ApiErrorResponse,
    headers,
  );

const isTaskPriority = (value: unknown): value is 0 | 1 | 2 | 3 | 4 =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 4;

const parseCreateTaskRequest = (body: unknown): CreateTaskRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }

  const rawInput = (body as Record<string, unknown>).input;
  const rawPriority = (body as Record<string, unknown>).priority;
  const rawType = (body as Record<string, unknown>).type;

  if (typeof rawInput !== "string" || rawInput.trim() === "") {
    throw new HttpApiError(400, "BAD_REQUEST", "`input` must be a non-empty string");
  }

  if (rawPriority !== undefined && !isTaskPriority(rawPriority)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`priority` must be an integer in range 0..4");
  }

  if (rawType !== undefined && (typeof rawType !== "string" || rawType.trim() === "")) {
    throw new HttpApiError(400, "BAD_REQUEST", "`type` must be a non-empty string");
  }

  return {
    input: rawInput,
    priority: rawPriority,
    type: typeof rawType === "string" ? rawType : undefined,
  };
};

const parseScheduleTrigger = (value: unknown): ScheduleTrigger => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`trigger` must be a JSON object");
  }

  const trigger = value as Record<string, unknown>;
  const mode = trigger.mode;
  if (mode !== "delay" && mode !== "at" && mode !== "cron") {
    throw new HttpApiError(400, "BAD_REQUEST", "`trigger.mode` must be one of delay|at|cron");
  }

  if (mode === "delay") {
    const delaySeconds = trigger.delaySeconds;
    if (
      typeof delaySeconds !== "number" ||
      !Number.isFinite(delaySeconds) ||
      delaySeconds <= 0
    ) {
      throw new HttpApiError(400, "BAD_REQUEST", "`trigger.delaySeconds` must be > 0");
    }
    return { mode, delaySeconds };
  }

  if (mode === "at") {
    const runAt = trigger.runAt;
    if (typeof runAt !== "string" || runAt.trim() === "") {
      throw new HttpApiError(400, "BAD_REQUEST", "`trigger.runAt` must be a non-empty string");
    }
    return { mode, runAt: runAt.trim() };
  }

  const cron = trigger.cron;
  if (typeof cron !== "string" || cron.trim() === "") {
    throw new HttpApiError(400, "BAD_REQUEST", "`trigger.cron` must be a non-empty string");
  }
  const timezone = trigger.timezone;
  if (timezone !== undefined && timezone !== "UTC") {
    throw new HttpApiError(400, "BAD_REQUEST", "`trigger.timezone` must be UTC");
  }

  return {
    mode: "cron",
    cron: cron.trim(),
    timezone: "UTC",
  };
};

const parseCreateScheduleRequest = (body: unknown): CreateScheduleRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }

  const record = body as Record<string, unknown>;
  const dedupeKey = record.dedupeKey;
  const taskInput = record.taskInput;
  const taskType = record.taskType;
  const priority = record.priority;

  if (typeof dedupeKey !== "string" || dedupeKey.trim() === "") {
    throw new HttpApiError(400, "BAD_REQUEST", "`dedupeKey` must be a non-empty string");
  }
  if (typeof taskInput !== "string" || taskInput.trim() === "") {
    throw new HttpApiError(400, "BAD_REQUEST", "`taskInput` must be a non-empty string");
  }
  if (taskType !== undefined && (typeof taskType !== "string" || taskType.trim() === "")) {
    throw new HttpApiError(400, "BAD_REQUEST", "`taskType` must be a non-empty string");
  }
  if (priority !== undefined && !isTaskPriority(priority)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`priority` must be an integer in range 0..4");
  }

  return {
    dedupeKey: dedupeKey.trim(),
    taskInput,
    ...(typeof taskType === "string" ? { taskType: taskType.trim() } : {}),
    ...(typeof priority === "number" ? { priority } : {}),
    trigger: parseScheduleTrigger(record.trigger),
  };
};

const parseMemorySearchRequest = (body: unknown): AgentMemorySearchRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }

  const record = body as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.trim() === "") {
    throw new HttpApiError(400, "BAD_REQUEST", "`query` must be a non-empty string");
  }
  if (record.limit !== undefined && (!Number.isInteger(record.limit) || (record.limit as number) <= 0)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`limit` must be a positive integer");
  }
  if (
    record.mode !== undefined &&
    record.mode !== "auto" &&
    record.mode !== "fts" &&
    record.mode !== "like"
  ) {
    throw new HttpApiError(400, "BAD_REQUEST", "`mode` must be one of auto|fts|like");
  }

  return {
    query: record.query.trim(),
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    ...(typeof record.mode === "string" ? { mode: record.mode as "auto" | "fts" | "like" } : {}),
    ...(typeof record.hydrateTagRefs === "boolean" ? { hydrateTagRefs: record.hydrateTagRefs } : {}),
  };
};

const parseMemoryGetRequest = (body: unknown): AgentMemoryGetRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const entryId = typeof record.entryId === "number" ? Math.trunc(record.entryId) : undefined;
  const blockId = typeof record.blockId === "string" ? record.blockId.trim() : undefined;

  if ((entryId === undefined || entryId <= 0) && (!blockId || blockId.length === 0)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`entryId` or `blockId` is required");
  }

  return {
    ...(entryId !== undefined && entryId > 0 ? { entryId } : {}),
    ...(blockId ? { blockId } : {}),
  };
};

const parseMemoryUpsertRequest = (body: unknown): AgentMemoryUpsertRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw new HttpApiError(400, "BAD_REQUEST", "`items` must be a non-empty array");
  }

  const items = record.items.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new HttpApiError(400, "BAD_REQUEST", `items[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.blockId !== "string" || entry.blockId.trim() === "") {
      throw new HttpApiError(400, "BAD_REQUEST", `items[${index}].blockId must be a non-empty string`);
    }
    if (typeof entry.content !== "string" || entry.content.trim() === "") {
      throw new HttpApiError(400, "BAD_REQUEST", `items[${index}].content must be a non-empty string`);
    }

    return {
      blockId: entry.blockId.trim(),
      content: entry.content.trim(),
      ...(entry.sourceTier === "core" || entry.sourceTier === "longterm"
        ? { sourceTier: entry.sourceTier as "core" | "longterm" }
        : {}),
      ...(typeof entry.type === "string" && entry.type.trim()
        ? { type: entry.type.trim() }
        : {}),
      ...(Array.isArray(entry.tags)
        ? { tags: entry.tags.filter((tag): tag is string => typeof tag === "string") }
        : {}),
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
      ...(typeof entry.decay === "number" ? { decay: entry.decay } : {}),
      ...(typeof entry.round === "number" ? { round: Math.trunc(entry.round) } : {}),
      ...(typeof entry.sourceTaskId === "string" ? { sourceTaskId: entry.sourceTaskId } : {}),
    };
  });

  return { items };
};

const parseMemoryUpdateRequest = (body: unknown): AgentMemoryUpdateRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.entryId !== "number" || !Number.isInteger(record.entryId) || record.entryId <= 0) {
    throw new HttpApiError(400, "BAD_REQUEST", "`entryId` must be a positive integer");
  }
  if (typeof record.patch !== "object" || record.patch === null || Array.isArray(record.patch)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`patch` must be an object");
  }

  return {
    entryId: Math.trunc(record.entryId),
    patch: record.patch as AgentMemoryUpdateRequest["patch"],
  };
};

const parseMemoryDeleteRequest = (body: unknown): AgentMemoryDeleteRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const entryId = typeof record.entryId === "number" ? Math.trunc(record.entryId) : undefined;
  const blockId = typeof record.blockId === "string" ? record.blockId.trim() : undefined;
  if ((entryId === undefined || entryId <= 0) && (!blockId || blockId.length === 0)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`entryId` or `blockId` is required");
  }
  return {
    ...(entryId !== undefined && entryId > 0 ? { entryId } : {}),
    ...(blockId ? { blockId } : {}),
  };
};

const parseMemoryFeedbackRequest = (body: unknown): AgentMemoryFeedbackRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.entryId !== "number" || !Number.isInteger(record.entryId) || record.entryId <= 0) {
    throw new HttpApiError(400, "BAD_REQUEST", "`entryId` must be a positive integer");
  }
  if (record.direction !== "positive" && record.direction !== "negative") {
    throw new HttpApiError(400, "BAD_REQUEST", "`direction` must be positive|negative");
  }
  return {
    entryId: Math.trunc(record.entryId),
    direction: record.direction,
  };
};

const parseMemoryTagResolveRequest = (body: unknown): AgentMemoryTagResolveRequest => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.tagId !== "string" || record.tagId.trim() === "") {
    throw new HttpApiError(400, "BAD_REQUEST", "`tagId` must be a non-empty string");
  }
  return {
    tagId: record.tagId.trim(),
    ...(typeof record.hydrateEntries === "boolean" ? { hydrateEntries: record.hydrateEntries } : {}),
  };
};

const parseMemoryListRecentRequest = (body: unknown): AgentMemoryListRecentRequest => {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpApiError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record.limit !== undefined && (!Number.isInteger(record.limit) || (record.limit as number) <= 0)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`limit` must be a positive integer");
  }
  return {
    ...(typeof record.limit === "number" ? { limit: Math.trunc(record.limit) } : {}),
  };
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new HttpApiError(400, "BAD_REQUEST", "Invalid JSON body");
  }
};

const parseAfterSeq = (url: URL): number => {
  const raw = url.searchParams.get("afterSeq");
  if (raw === null || raw === "") {
    return 0;
  }

  if (!/^\d+$/.test(raw)) {
    throw new HttpApiError(400, "BAD_REQUEST", "`afterSeq` must be a non-negative integer");
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpApiError(400, "BAD_REQUEST", "`afterSeq` must be a non-negative integer");
  }

  return value;
};

const methodNotAllowed = (allow: string[]) =>
  fail(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: allow.join(", ") });

const notFound = () => fail(404, "NOT_FOUND", "Not found");

const toInternalErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const startHttpGateway = (options: StartHttpGatewayOptions): HttpGatewayServer => {
  const {
    runtime,
    host,
    port,
    appName,
    version,
    startupAt,
    getMcpStatus,
    getMessageGatewayStatus,
  } = options;

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: async (request: Request) => {
      try {
        const url = new URL(request.url);
        const { pathname } = url;

        if (pathname === "/healthz") {
          if (request.method !== "GET") {
            return methodNotAllowed(["GET"]);
          }
          const probeHttp = url.searchParams.get("probeMcpHttp") === "1";

          const health: HealthzResponse = {
            name: appName,
            version,
            startupAt,
            queue: await runtime.getQueueStats(),
          };
          if (getMcpStatus) {
            health.mcp = await getMcpStatus({ probeHttp });
          }
          if (getMessageGatewayStatus) {
            health.messageGateway = await getMessageGatewayStatus();
          }

          return ok(health);
        }

        if (pathname === "/v1/tasks") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }

          const body = await parseJsonBody(request);
          const payload = parseCreateTaskRequest(body);
          const created = await runtime.submitTask(payload);
          return ok(created, 202);
        }

        if (pathname === "/v1/schedules") {
          if (request.method === "POST") {
            if (!runtime.createSchedule) {
              throw new HttpApiError(404, "NOT_FOUND", "Schedule API unavailable");
            }
            const payload = parseCreateScheduleRequest(await parseJsonBody(request));
            return ok(await runtime.createSchedule(payload), 202);
          }

          if (request.method === "GET") {
            if (!runtime.listSchedules) {
              throw new HttpApiError(404, "NOT_FOUND", "Schedule API unavailable");
            }
            return ok(await runtime.listSchedules());
          }

          return methodNotAllowed(["GET", "POST"]);
        }

        if (pathname.startsWith("/v1/schedules/")) {
          if (request.method !== "DELETE") {
            return methodNotAllowed(["DELETE"]);
          }
          if (!runtime.cancelSchedule) {
            throw new HttpApiError(404, "NOT_FOUND", "Schedule API unavailable");
          }

          const rawScheduleId = pathname.slice("/v1/schedules/".length);
          if (!rawScheduleId) {
            return notFound();
          }

          let scheduleId = rawScheduleId;
          try {
            scheduleId = decodeURIComponent(rawScheduleId);
          } catch {
            throw new HttpApiError(400, "BAD_REQUEST", "Invalid schedule id");
          }

          return ok(await runtime.cancelSchedule(scheduleId));
        }

        if (pathname === "/forceabort") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }

          return ok(await runtime.forceAbort());
        }

        if (pathname.startsWith("/v1/tasks/")) {
          if (request.method !== "GET") {
            return methodNotAllowed(["GET"]);
          }

          const rawTaskId = pathname.slice("/v1/tasks/".length);
          if (!rawTaskId) {
            return notFound();
          }

          let taskId = rawTaskId;
          try {
            taskId = decodeURIComponent(rawTaskId);
          } catch {
            throw new HttpApiError(400, "BAD_REQUEST", "Invalid task id");
          }

          const afterSeq = parseAfterSeq(url);
          const task = await runtime.getTask(taskId, { afterSeq });
          if (!task) {
            return fail(404, "NOT_FOUND", `Task not found: ${taskId}`);
          }

          return ok(task);
        }

        if (pathname === "/v1/agent/context") {
          if (request.method !== "GET") {
            return methodNotAllowed(["GET"]);
          }

          return ok(await runtime.getAgentContext());
        }

        if (pathname === "/v1/agent/messages") {
          if (request.method !== "GET") {
            return methodNotAllowed(["GET"]);
          }

          return ok(await runtime.getAgentMessages());
        }

        if (pathname === "/v1/agent/memory/search") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memorySearch) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemorySearchRequest(await parseJsonBody(request));
          return ok(await runtime.memorySearch(payload));
        }

        if (pathname === "/v1/agent/memory/get") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryGet) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryGetRequest(await parseJsonBody(request));
          return ok(await runtime.memoryGet(payload));
        }

        if (pathname === "/v1/agent/memory/upsert") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryUpsert) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryUpsertRequest(await parseJsonBody(request));
          return ok(await runtime.memoryUpsert(payload));
        }

        if (pathname === "/v1/agent/memory/update") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryUpdate) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryUpdateRequest(await parseJsonBody(request));
          return ok(await runtime.memoryUpdate(payload));
        }

        if (pathname === "/v1/agent/memory/delete") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryDelete) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryDeleteRequest(await parseJsonBody(request));
          return ok(await runtime.memoryDelete(payload));
        }

        if (pathname === "/v1/agent/memory/feedback") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryFeedback) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryFeedbackRequest(await parseJsonBody(request));
          return ok(await runtime.memoryFeedback(payload));
        }

        if (pathname === "/v1/agent/memory/tag_resolve") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryTagResolve) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryTagResolveRequest(await parseJsonBody(request));
          return ok(await runtime.memoryTagResolve(payload));
        }

        if (pathname === "/v1/agent/memory/stats") {
          if (request.method !== "GET") {
            return methodNotAllowed(["GET"]);
          }
          if (!runtime.memoryStats) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          return ok(await runtime.memoryStats());
        }

        if (pathname === "/v1/agent/memory/compact") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryCompact) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          return ok(await runtime.memoryCompact());
        }

        if (pathname === "/v1/agent/memory/list_recent") {
          if (request.method !== "POST") {
            return methodNotAllowed(["POST"]);
          }
          if (!runtime.memoryListRecent) {
            throw new HttpApiError(404, "NOT_FOUND", "Memory API unavailable");
          }
          const payload = parseMemoryListRecentRequest(await parseJsonBody(request));
          return ok(await runtime.memoryListRecent(payload));
        }

        return notFound();
      } catch (error) {
        if (error instanceof HttpApiError) {
          return fail(error.status, error.code, error.message);
        }

        return fail(500, "INTERNAL_ERROR", toInternalErrorMessage(error));
      }
    },
  });

  const resolvedPort = server.port ?? port;
  const baseUrl = `http://${host}:${resolvedPort}`;

  return {
    host,
    port: resolvedPort,
    baseUrl,
    raw: server,
    stop: () => {
      server.stop();
    },
  };
};
