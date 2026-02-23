/* Runtime */
import { join } from "node:path";
import readline from "node:readline";
import { readFileSync } from "node:fs";

/* AI SDK */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { PriorityTaskQueue, createTask } from "./libs/runtime/queue";
import { sleep } from "bun";
import { TaskStatus, type TaskItem } from "./types/task";

/* Framework */
import { bootstrap } from "./libs/agent/boot";
import { workspace_check } from "./libs/utils/workspace_check";
import { Agent } from "./libs/agent/agent";
import { loadAgentConfig } from "./libs/agent/config";
import { parseCliOptions } from "./libs/utils/cli";
import { initMCPTools } from "./libs/mcp";

/* 创建全局大语言模型处理对象 */
const GlobalModel = createDeepSeek({
  apiKey: process.env.AI_API_KEY,
})("deepseek-chat");

const GLOBAL_VAR_TABLE = new Map();

const APP_NAME = "Atom";

const getAppVersion = (): string => {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      version?: string;
    };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
};

const formatDuration = (startTime: number): string =>
  `${(performance.now() - startTime).toFixed(0)}ms`;

const logStage = (message: string) => console.log(`[startup] ${message}`);

const printStartupBanner = (version: string) => {
  console.log(`${APP_NAME} v${version}`);
  console.log("Commands: `messages`, `context`, `exit`");
};

const startRepl = (
  taskAgent: Agent,
  taskQueue: PriorityTaskQueue,
) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask() {
    rl.question("> ", async (input) => {
      const command = input.trim();

      if (command === "exit") {
        rl.close();
        return;
      }

      if (command === "messages") {
        taskAgent.displayMessages();
        ask();
        return;
      }

      if (command === "context") {
        taskAgent.displayContext();
        ask();
        return;
      }

      if (!command) {
        ask();
        return;
      }

      const task = createTask<string, string>("rl.input", command);
      taskQueue.add(task);

      while (
        task.status === TaskStatus.Pending ||
        task.status === TaskStatus.Running
      ) {
        await sleep(1000);
      }

      if (task.status === TaskStatus.Success && task.result !== undefined) {
        console.log("Answer:", task.result);
      } else if (task.status === TaskStatus.Failed) {
        console.error("Error:", task.error?.message ?? "Unknown error");
      } else if (task.status === TaskStatus.Cancelled) {
        console.log("Task was cancelled");
      } else {
        console.log("Task completed with unexpected status:", task.status);
      }

      ask();
    });
  }

  ask();
};

const main = async () => {
  const startupStartTime = performance.now();
  const version = getAppVersion();
  printStartupBanner(version);

  const startupCwd = process.cwd();
  const cliOptions = parseCliOptions(process.argv.slice(2), startupCwd);
  logStage(`workspace = ${cliOptions.workspace}`);
  if (cliOptions.configPath) {
    logStage(`config = ${cliOptions.configPath}`);
  }

  logStage("checking workspace...");
  await workspace_check(cliOptions.workspace);
  logStage("workspace ready");

  logStage("loading agent config...");
  const agentConfig = await loadAgentConfig({
    workspace: cliOptions.workspace,
    configPath: cliOptions.configPath,
  });
  logStage("agent config loaded");

  logStage("initializing MCP servers...");
  const { tools: mcpTools, status: mcpStatus } = await initMCPTools(agentConfig.mcp);
  for (const serverStatus of mcpStatus) {
    if (serverStatus.available) {
      console.log(
        `[mcp] ${serverStatus.id}: OK | url=${serverStatus.url ?? "unknown"} | tools=${serverStatus.toolCount ?? 0}`,
      );
      if ((serverStatus.toolNames?.length ?? 0) > 0) {
        console.log(`[mcp] ${serverStatus.id}: ${serverStatus.toolNames!.join(", ")}`);
      }
      continue;
    }

    console.warn(
      `[mcp] ${serverStatus.id}: unavailable | url=${serverStatus.url ?? "unknown"} | ${serverStatus.message ?? "Unknown error"}`,
    );
  }

  const mcpAvailableCount = mcpStatus.filter((status) => status.available).length;
  logStage(`MCP ready (${mcpAvailableCount}/${mcpStatus.length})`);

  logStage("compiling agent prompt...");
  const { systemPrompt } = await bootstrap(GlobalModel)({
    userPromptFilePath: join(cliOptions.workspace, "AGENT.md"),
    enableOptimization: true,
  });
  logStage("prompt compiled");

  logStage("creating agent...");
  const taskAgent = new Agent({
    systemPrompt,
    model: GlobalModel,
    workspace: cliOptions.workspace,
    toolContext: { permissions: agentConfig },
    mcpTools,
  });

  logStage("starting task queue...");
  const taskQueue = new PriorityTaskQueue(
    async (task: TaskItem<string, string>) => {
      console.log("[agent] thinking...");
      return await taskAgent.runTask(task.input);
      // return await taskAgent.runAsyncTask(task.input);
    },
  );
  taskQueue.start();

  logStage(`ready in ${formatDuration(startupStartTime)}`);
  startRepl(taskAgent, taskQueue);
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[startup] failed: ${message}`);
  process.exit(1);
}
