import type { MCPServerStatus } from "./index";
import type { MCPHealthStatus, MCPServerHealthStatus } from "../../types/http";

type ProbeOptions = {
  probeHttp?: boolean;
};

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

type CreateMCPHealthStatusProviderArgs = {
  startupStatus: MCPServerStatus[];
  fetchFn?: FetchLike;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 1500;

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const probeHttpTarget = async (args: {
  url: string;
  fetchFn: FetchLike;
  timeoutMs: number;
}): Promise<{ connected: boolean; message?: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort("timeout");
  }, args.timeoutMs);

  try {
    const response = await args.fetchFn(args.url, {
      method: "GET",
      signal: controller.signal,
    });
    return { connected: response.status < 500 };
  } catch (error) {
    return { connected: false, message: toErrorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeServerStatus = (args: {
  server: MCPServerStatus;
  connected: boolean;
  message?: string;
  testedAt: number;
}): MCPServerHealthStatus => ({
  id: args.server.id,
  transport: args.server.transportType,
  connected: args.connected,
  target: args.server.target,
  message: args.message,
  testedAt: args.testedAt,
});

export const createMCPHealthStatusProvider = (args: CreateMCPHealthStatusProviderArgs) => {
  const fetchFn = (args.fetchFn ?? fetch) as FetchLike;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (options?: ProbeOptions): Promise<MCPHealthStatus> => {
    const testedAt = Date.now();
    const servers = await Promise.all(
      args.startupStatus.map(async (server) => {
        if (server.transportType !== "http" || options?.probeHttp !== true || !server.target) {
          return normalizeServerStatus({
            server,
            connected: server.available,
            message: server.available ? undefined : server.message,
            testedAt,
          });
        }

        const probed = await probeHttpTarget({
          url: server.target,
          fetchFn,
          timeoutMs,
        });
        return normalizeServerStatus({
          server,
          connected: probed.connected,
          message: probed.message,
          testedAt,
        });
      }),
    );

    return {
      connected: servers.filter((item) => item.connected).length,
      total: servers.length,
      servers,
    };
  };
};
