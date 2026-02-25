import type { MCPConfig, MCPServerConfig, MCPServerTransportConfig } from "../../types/agent";
import type { ToolDefinitionMap } from "../agent/tools";

export type MCPTools = ToolDefinitionMap;

export type MCPServerStatus = {
  id: string;
  enabled: boolean;
  available: boolean;
  transportType: MCPServerConfig["transport"]["type"];
  target?: string;
  message?: string;
  toolCount?: number;
  toolNames?: string[];
};

type MCPClientLike = {
  tools(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

export type InitMCPToolsResult = {
  tools: MCPTools;
  status: MCPServerStatus[];
  dispose: () => Promise<void>;
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const sanitizeToolNameSegment = (value: string) => {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "tool";
};

const prefixTools = (serverId: string, toolMap: ToolDefinitionMap): MCPTools => {
  const namespacedTools: MCPTools = {};
  const usedNames = new Set<string>();

  for (const [toolName, tool] of Object.entries(toolMap)) {
    const safeToolName = sanitizeToolNameSegment(toolName);
    let namespacedName = `${serverId}__${safeToolName}`;
    let index = 2;

    while (usedNames.has(namespacedName)) {
      namespacedName = `${serverId}__${safeToolName}_${index}`;
      index += 1;
    }

    usedNames.add(namespacedName);
    namespacedTools[namespacedName] = tool;
  }

  return namespacedTools;
};

const getTransportTarget = (transport: MCPServerTransportConfig) =>
  transport.type === "http" ? transport.url : transport.command;

const safeCloseMCPClient = async (
  client: Pick<MCPClientLike, "close">,
  meta: Pick<MCPServerStatus, "id" | "transportType" | "target">,
) => {
  try {
    await client.close();
  } catch (error) {
    console.warn(
      `[mcp] ${meta.id}: close failed | transport=${meta.transportType} | target=${meta.target ?? "unknown"} | ${toErrorMessage(error)}`,
    );
  }
};

type MCPClientTransport = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
} | {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
};

const createClientTransportFactory = () => {
  let stdioTransportCtorPromise:
    | Promise<typeof import("@ai-sdk/mcp/mcp-stdio").Experimental_StdioMCPTransport>
    | undefined;

  const getStdioTransportCtor = async () => {
    if (!stdioTransportCtorPromise) {
      stdioTransportCtorPromise = import("@ai-sdk/mcp/mcp-stdio").then(
        (mod) => mod.Experimental_StdioMCPTransport,
      );
    }

    return stdioTransportCtorPromise;
  };

  return async (server: MCPServerConfig): Promise<MCPClientTransport> => {
    const transport = server.transport;

    if (transport.type === "http") {
      return {
        type: "http",
        url: transport.url,
        headers: transport.headers,
      };
    }

    const Experimental_StdioMCPTransport = await getStdioTransportCtor();
    return new Experimental_StdioMCPTransport({
      command: transport.command,
      args: transport.args,
      env: transport.env,
      cwd: transport.cwd,
    });
  };
};

export const initMCPTools = async (
  config?: MCPConfig,
): Promise<InitMCPToolsResult> => {
  const servers = config?.servers ?? [];
  const enabledServers = servers.filter((server) => server.enabled !== false);

  if (enabledServers.length === 0) {
    return { tools: {}, status: [], dispose: async () => {} };
  }

  let createMCPClient: any;
  try {
    ({ createMCPClient } = await import("@ai-sdk/mcp"));
  } catch (error) {
    const message = `MCP SDK unavailable: ${toErrorMessage(error)}`;
    return {
      tools: {},
      status: enabledServers.map((server) => ({
        id: server.id,
        enabled: true,
        available: false,
        transportType: server.transport.type,
        target: getTransportTarget(server.transport),
        message,
      })),
      dispose: async () => {},
    };
  }

  const buildClientTransport = createClientTransportFactory();
  const activeClients: Array<{
    id: string;
    transportType: MCPServerStatus["transportType"];
    target?: string;
    client: MCPClientLike;
  }> = [];

  const results = await Promise.all(
    enabledServers.map(async (server) => {
      let client: MCPClientLike | undefined;
      const meta = {
        id: server.id,
        transportType: server.transport.type,
        target: getTransportTarget(server.transport),
      } satisfies Pick<MCPServerStatus, "id" | "transportType" | "target">;

      try {
        client = (await createMCPClient({
          transport: await buildClientTransport(server),
        })) as MCPClientLike;
        const rawTools = (await client.tools()) as ToolDefinitionMap;
        const tools = prefixTools(server.id, rawTools);
        activeClients.push({ ...meta, client });

        return {
          tools,
          status: {
            id: server.id,
            enabled: true,
            available: true,
            transportType: meta.transportType,
            target: meta.target,
            toolCount: Object.keys(rawTools).length,
            toolNames: Object.keys(rawTools),
          } satisfies MCPServerStatus,
        };
      } catch (error) {
        if (client) {
          await safeCloseMCPClient(client, meta);
        }

        return {
          tools: {},
          status: {
            id: server.id,
            enabled: true,
            available: false,
            transportType: meta.transportType,
            target: meta.target,
            message: toErrorMessage(error),
          } satisfies MCPServerStatus,
        };
      }
    }),
  );

  const mergedTools = results.reduce<MCPTools>(
    (acc, result) => ({ ...acc, ...result.tools }),
    {},
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;

    await Promise.all(
      activeClients.map(({ client, ...meta }) => safeCloseMCPClient(client, meta)),
    );
  };

  return {
    tools: mergedTools,
    status: results.map((result) => result.status),
    dispose,
  };
};
