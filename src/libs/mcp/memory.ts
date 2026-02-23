import { createMCPClient } from "@ai-sdk/mcp";

export const memoryMCPClient = await createMCPClient({
  transport: {
    type: "http",
    url: "http://localhost:8787/mcp",
  },
});
