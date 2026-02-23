import type { MCPConfig } from "../../types/agent";
import type { ToolDefinitionMap } from "../agent/tools";

export type MCPTools = ToolDefinitionMap;

export type MCPServerStatus = {
  id: string;
  enabled: boolean;
  available: boolean;
  url?: string;
  message?: string;
  toolCount?: number;
  toolNames?: string[];
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const prefixTools = (serverId: string, toolMap: ToolDefinitionMap): MCPTools => {
  const namespacedTools: MCPTools = {};

  for (const [toolName, tool] of Object.entries(toolMap)) {
    namespacedTools[`${serverId}:${toolName}`] = tool;
  }

  return namespacedTools;
};

export const initMCPTools = async (
  config?: MCPConfig,
): Promise<{ tools: MCPTools; status: MCPServerStatus[] }> => {
  const servers = config?.servers ?? [];
  const enabledServers = servers.filter((server) => server.enabled !== false);

  if (enabledServers.length === 0) {
    return { tools: {}, status: [] };
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
        url: server.transport.url,
        message,
      })),
    };
  }

  const results = await Promise.all(
    enabledServers.map(async (server) => {
      try {
        const client = await createMCPClient({
          transport: {
            type: "http",
            url: server.transport.url,
            headers: server.transport.headers,
          },
        });
        const rawTools = (await client.tools()) as ToolDefinitionMap;
        const tools = prefixTools(server.id, rawTools);

        return {
          tools,
          status: {
            id: server.id,
            enabled: true,
            available: true,
            url: server.transport.url,
            toolCount: Object.keys(rawTools).length,
            toolNames: Object.keys(rawTools),
          } satisfies MCPServerStatus,
        };
      } catch (error) {
        return {
          tools: {},
          status: {
            id: server.id,
            enabled: true,
            available: false,
            url: server.transport.url,
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

  return {
    tools: mergedTools,
    status: results.map((result) => result.status),
  };
};
