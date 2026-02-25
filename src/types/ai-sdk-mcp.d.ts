declare module "@ai-sdk/mcp" {
  export type MCPTransport = {
    start(): Promise<void>;
    send(message: unknown): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
    onerror?: (error: unknown) => void;
    onmessage?: (message: unknown) => void;
  };

  export function createMCPClient(options: {
    transport:
      | {
          type: "http" | "sse";
          url: string;
          headers?: Record<string, string>;
        }
      | MCPTransport;
  }): Promise<{
    tools(): Promise<Record<string, unknown>>;
    close(): Promise<void>;
  }>;
}

declare module "@ai-sdk/mcp/mcp-stdio" {
  export type StdioConfig = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: unknown;
  };

  export class Experimental_StdioMCPTransport {
    constructor(config: StdioConfig);
    start(): Promise<void>;
    send(message: unknown): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
    onerror?: (error: unknown) => void;
    onmessage?: (message: unknown) => void;
  }
}
