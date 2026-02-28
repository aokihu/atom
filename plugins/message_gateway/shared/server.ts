type Logger = Pick<Console, "log" | "warn">;

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export type PluginServerOptions = {
  channelId: string;
  host: string;
  port: number;
  healthPath: string;
  invokePath: string;
  methods: Record<string, RpcHandler>;
  logger?: Logger;
  captureSignals?: boolean;
};

type RpcRequestPayload = {
  method?: unknown;
  params?: unknown;
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const parseJsonEnv = <T>(name: string): T => {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON in env ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const startPluginServer = (options: PluginServerOptions) => {
  const logger = options.logger ?? console;
  let shutdownRequested = false;

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === options.healthPath) {
        if (request.method !== "GET") {
          return json(405, {
            ok: false,
            error: "Method not allowed",
          });
        }
        return json(200, {
          ok: true,
          data: {
            channelId: options.channelId,
            status: "ok",
            uptimeMs: process.uptime() * 1000,
          },
        });
      }

      if (url.pathname === options.invokePath) {
        if (request.method !== "POST") {
          return json(405, {
            ok: false,
            error: "Method not allowed",
          });
        }

        let payload: RpcRequestPayload;
        try {
          payload = (await request.json()) as RpcRequestPayload;
        } catch {
          return json(400, {
            ok: false,
            error: "Invalid JSON payload",
          });
        }

        if (typeof payload.method !== "string" || payload.method.trim() === "") {
          return json(400, {
            ok: false,
            error: "Missing RPC method",
          });
        }
        const method = payload.method.trim();
        const handler = options.methods[method];
        if (!handler) {
          return json(404, {
            ok: false,
            error: `Unknown method: ${method}`,
          });
        }
        if (
          payload.params !== undefined &&
          (typeof payload.params !== "object" || payload.params === null || Array.isArray(payload.params))
        ) {
          return json(400, {
            ok: false,
            error: "RPC params must be an object",
          });
        }

        try {
          const result = await handler((payload.params as Record<string, unknown> | undefined) ?? {});
          return json(200, {
            ok: true,
            result,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json(500, {
            ok: false,
            error: message,
          });
        }
      }

      return json(404, {
        ok: false,
        error: "Not found",
      });
    },
  });

  const shutdown = async () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    server.stop();
  };

  const onSignal = (signal: NodeJS.Signals) => {
    logger.log(`[message_gateway:${options.channelId}] received ${signal}, shutting down`);
    void shutdown();
  };

  if (options.captureSignals !== false) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return {
    host: options.host,
    port: server.port ?? options.port,
    shutdown,
    dispose: () => {
      if (options.captureSignals !== false) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    },
  };
};
