import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeGateway } from "../channel/channel";
import { TaskStatus } from "../../types/task";
import { MessageGatewayManager } from "./manager";

const runningManagers: MessageGatewayManager[] = [];

const createRuntime = (): RuntimeGateway & {
  submittedInputs: string[];
} => {
  const submittedInputs: string[] = [];
  return {
    submittedInputs,
    submitTask(request) {
      submittedInputs.push(request.input);
      return {
        taskId: "task-1",
        task: {
          id: "task-1",
          type: request.type ?? "message_gateway.input",
          priority: request.priority ?? 2,
          status: TaskStatus.Pending,
          input: request.input,
          retries: 0,
          maxRetries: 1,
          createAt: Date.now(),
          cancellable: true,
        },
      };
    },
    getTask() {
      return {
        task: {
          id: "task-1",
          type: "message_gateway.input",
          priority: 2,
          status: TaskStatus.Success,
          input: "ignored",
          result: "echo reply",
          retries: 0,
          maxRetries: 1,
          createAt: Date.now(),
          finishedAt: Date.now(),
          cancellable: true,
        },
      };
    },
    getQueueStats() {
      return { size: 0 };
    },
    getAgentContext() {
      return {
        context: {
          version: 3,
          runtime: {
            round: 0,
            workspace: "/tmp",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
            longterm: [],
          },
        },
        injectedContext: {
          version: 3,
          runtime: {
            round: 0,
            workspace: "/tmp",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
            longterm: [],
          },
        },
        projectionDebug: {
          round: 0,
          rawCounts: {
            core: 0,
            working: 0,
            ephemeral: 0,
            longterm: 0,
          },
          injectedCounts: {
            core: 0,
            working: 0,
            ephemeral: 0,
            longterm: 0,
          },
          droppedByReason: {
            working_status_terminal: 0,
            threshold_decay: 0,
            threshold_confidence: 0,
            expired_by_round: 0,
            over_max_items: 0,
            invalid_block: 0,
          },
          droppedSamples: {},
        },
      };
    },
    getAgentMessages() {
      return { messages: [] };
    },
    forceAbort() {
      return {
        abortedCurrent: false,
        clearedPendingCount: 0,
        timestamp: Date.now(),
      };
    },
  };
};

const getFreePort = (): number => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port ?? 0;
  server.stop();
  if (port <= 0) {
    throw new Error("failed to allocate test port");
  }
  return port;
};

afterEach(async () => {
  while (runningManagers.length > 0) {
    const manager = runningManagers.pop();
    if (manager) {
      await manager.stop();
    }
  }
});

describe("MessageGatewayManager", () => {
  test("starts configured channel and accepts inbound request", async () => {
    const workspaceBase = join(process.cwd(), ".tmp-tests");
    await mkdir(workspaceBase, { recursive: true });
    const workspace = await mkdtemp(join(workspaceBase, "atom-message-gateway-manager-"));
    const port = getFreePort();
    await writeFile(
      join(workspace, "message_gateway.config.json"),
      JSON.stringify(
        {
          gateway: {
            enabled: true,
            auth: {
              bearerToken: "token-123",
            },
          },
          channels: [
            {
              id: "http_ingress",
              type: "http",
              enabled: true,
              channelEndpoint: {
                host: "127.0.0.1",
                port,
              },
              settings: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const runtime = createRuntime();
    const manager = await MessageGatewayManager.create({
      workspace,
      runtime,
      includeChannels: ["http_ingress"],
      logger: { log() {}, warn() {} },
    });
    runningManagers.push(manager);
    await manager.start();

    const url = new URL("http://127.0.0.1/v1/message-gateway/inbound");
    url.searchParams.set("channelId", "http_ingress");
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token-123",
      },
      body: JSON.stringify({
        text: "hello",
        conversationId: "c1",
      }),
    });

    const response = await manager.handleInbound(request, url);
    expect(response.status).toBe(202);

    await Bun.sleep(150);
    expect(runtime.submittedInputs.length).toBe(1);
    expect(runtime.submittedInputs[0]).toContain("channel=http_ingress");
  });
});
