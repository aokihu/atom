declare module "@ai-sdk/mcp" {
  export function createMCPClient(options: {
    transport: {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    };
  }): Promise<{
    tools(): Promise<Record<string, unknown>>;
  }>;
}
