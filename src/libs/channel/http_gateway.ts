import type { RuntimeGateway } from "./channel";
import type {
  ApiErrorCode,
  ApiErrorResponse,
  ApiSuccessResponse,
  CreateTaskRequest,
  HealthzResponse,
} from "../../types/http";

type StartHttpGatewayOptions = {
  runtime: RuntimeGateway;
  host: string;
  port: number;
  appName: string;
  version: string;
  startupAt: number;
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
  const { runtime, host, port, appName, version, startupAt } = options;

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

          const health: HealthzResponse = {
            name: appName,
            version,
            startupAt,
            queue: await runtime.getQueueStats(),
          };

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
