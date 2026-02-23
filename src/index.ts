/* Runtime */
import { join } from "node:path";
import { readFileSync } from "node:fs";

/* AI SDK */
import { createDeepSeek } from "@ai-sdk/deepseek";

/* Framework */
import { bootstrap } from "./libs/agent/boot";
import { workspace_check } from "./libs/utils/workspace_check";
import { Agent } from "./libs/agent/agent";
import { loadAgentConfig } from "./libs/agent/config";
import { parseCliOptions, type CliOptions } from "./libs/utils/cli";
import { initMCPTools } from "./libs/mcp";
import { AgentRuntimeService } from "./libs/runtime";
import { HttpGatewayClient, startHttpGateway } from "./libs/channel";
import { startTuiClient } from "./clients";

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

const printStartupBanner = (version: string, mode: CliOptions["mode"]) => {
  console.log(`${APP_NAME} v${version} (${mode})`);
};

const printTuiCommands = () => {
  console.log("Commands: `/help`, `/messages`, `/context`, `/exit`");
};

const createModel = () =>
  createDeepSeek({
    apiKey: process.env.AI_API_KEY,
  })("deepseek-chat");

type ShutdownController = {
  run: (reason?: string) => Promise<void>;
  wait: Promise<void>;
  dispose: () => void;
};

const createShutdownController = (
  cleanup: () => Promise<void> | void,
): ShutdownController => {
  let shuttingDown = false;
  let resolveWait: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  const run = async (reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (reason) {
      console.log(`[shutdown] ${reason}`);
    }

    try {
      await cleanup();
    } finally {
      resolveWait?.();
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void run(`signal ${signal}`);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    run,
    wait,
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
};

const buildServerUrl = (options: Pick<CliOptions, "httpHost" | "httpPort" | "serverUrl">) =>
  options.serverUrl ?? `http://${options.httpHost}:${options.httpPort}`;

const initializeRuntimeService = async (cliOptions: CliOptions) => {
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

  const model = createModel();

  logStage("compiling agent prompt...");
  const { systemPrompt } = await bootstrap(model)({
    userPromptFilePath: join(cliOptions.workspace, "AGENT.md"),
    enableOptimization: true,
  });
  logStage("prompt compiled");

  logStage("creating agent...");
  const taskAgent = new Agent({
    systemPrompt,
    model,
    workspace: cliOptions.workspace,
    toolContext: { permissions: agentConfig },
    mcpTools,
  });

  logStage("starting task runtime...");
  const runtimeService = new AgentRuntimeService(
    taskAgent,
    cliOptions.mode === "hybrid" ? { log: () => {} } : console,
  );
  runtimeService.start();

  return runtimeService;
};

const main = async () => {
  const startupStartTime = performance.now();
  const version = getAppVersion();
  const startupCwd = process.cwd();
  const cliOptions = parseCliOptions(process.argv.slice(2), startupCwd);

  printStartupBanner(version, cliOptions.mode);

  if (cliOptions.mode === "tui") {
    const serverUrl = buildServerUrl(cliOptions);
    console.log(`[tui] server = ${serverUrl}`);
    printTuiCommands();
    logStage(`ready in ${formatDuration(startupStartTime)}`);
    await startTuiClient({
      client: new HttpGatewayClient(serverUrl),
      serverUrl,
      mode: "tui",
    });
    return;
  }

  const runtimeService = await initializeRuntimeService(cliOptions);
  const gateway = startHttpGateway({
    runtime: runtimeService,
    host: cliOptions.httpHost,
    port: cliOptions.httpPort,
    appName: APP_NAME,
    version,
    startupAt: runtimeService.startupAt,
  });

  console.log(`[http] listening on ${gateway.baseUrl}`);

  const shutdown = createShutdownController(async () => {
    gateway.stop();
    runtimeService.stop();
  });

  logStage(`ready in ${formatDuration(startupStartTime)}`);

  if (cliOptions.mode === "server") {
    await shutdown.wait;
    shutdown.dispose();
    return;
  }

  printTuiCommands();
  try {
    await startTuiClient({
      client: new HttpGatewayClient(gateway.baseUrl),
      serverUrl: gateway.baseUrl,
      mode: "hybrid",
    });
  } finally {
    await shutdown.run("tui exit");
    shutdown.dispose();
  }
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[startup] failed: ${message}`);
  process.exit(1);
}
