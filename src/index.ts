/* Runtime */
import { join } from "node:path";
import { readFileSync } from "node:fs";

/* Framework */
import { bootstrap } from "./libs/agent/boot";
import { workspace_check } from "./libs/utils/workspace_check";
import { Agent } from "./libs/agent/agent";
import { loadAgentConfig } from "./libs/agent/config";
import {
  createLanguageModelFromAgentConfig,
  isOpenAICompatibleProvider,
  resolveSelectedProvider,
  resolveOpenAICompatibleProviderBaseURL,
} from "./libs/agent/providers/factory";
import { parseCliOptions, type CliOptions } from "./libs/utils/cli";
import { initMCPTools } from "./libs/mcp";
import { AgentRuntimeService } from "./libs/runtime";
import { HttpGatewayClient, startHttpGateway } from "./libs/channel";
import { startTuiClient } from "./clients";
import { cleanupInvalidBackgroundBashSessionsOnStartup } from "./libs/agent/tools/background_sessions";
import { cleanupTodoDbOnStartup } from "./libs/agent/tools/todo_store";

const DEFAULT_AGENT_NAME = "Atom";

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

const resolveAgentName = (agentName?: string): string => {
  const normalized = agentName?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_AGENT_NAME;
};

const printStartupBanner = (
  agentName: string,
  version: string,
  mode: CliOptions["mode"],
) => {
  console.log(`${agentName} v${version} (${mode})`);
};

const printTuiCommands = () => {
  console.log("Commands: `/help`, `/messages`, `/context`, `/exit`");
};

const printModelSelection = (
  agentConfig: Awaited<ReturnType<typeof loadAgentConfig>>,
) => {
  const selection = resolveSelectedProvider(agentConfig);
  const baseUrl = isOpenAICompatibleProvider(selection.providerId)
    ? resolveOpenAICompatibleProviderBaseURL(
        selection.providerId,
        selection.provider,
      )
    : undefined;

  console.log(
    baseUrl
      ? `[model] provider=${selection.providerId} | model=${selection.modelId} | base_url=${baseUrl}`
      : `[model] provider=${selection.providerId} | model=${selection.modelId}`,
  );

  const params = agentConfig.agent?.params;
  if (params && Object.keys(params).length > 0) {
    console.log(`[model.params] ${JSON.stringify(params)}`);
  }
};

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

const initializeRuntimeService = async (
  cliOptions: CliOptions,
  agentConfig: Awaited<ReturnType<typeof loadAgentConfig>>,
) => {
  logStage(`workspace = ${cliOptions.workspace}`);
  if (cliOptions.configPath) {
    logStage(`config = ${cliOptions.configPath}`);
  }

  logStage("initializing MCP servers...");
  const mcp = await initMCPTools(agentConfig.mcp);
  const { tools: mcpTools, status: mcpStatus } = mcp;
  for (const serverStatus of mcpStatus) {
    if (serverStatus.available) {
      console.log(
        `[mcp] ${serverStatus.id}: OK | transport=${serverStatus.transportType} | target=${serverStatus.target ?? "unknown"} | tools=${serverStatus.toolCount ?? 0}`,
      );
      if ((serverStatus.toolNames?.length ?? 0) > 0) {
        console.log(`[mcp] ${serverStatus.id}: ${serverStatus.toolNames!.join(", ")}`);
      }
      continue;
    }

    console.warn(
      `[mcp] ${serverStatus.id}: unavailable | transport=${serverStatus.transportType} | target=${serverStatus.target ?? "unknown"} | ${serverStatus.message ?? "Unknown error"}`,
    );
  }

  const mcpAvailableCount = mcpStatus.filter((status) => status.available).length;
  logStage(`MCP ready (${mcpAvailableCount}/${mcpStatus.length})`);

  try {
    const model = createLanguageModelFromAgentConfig(agentConfig);

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
      modelParams: agentConfig.agent?.params,
      workspace: cliOptions.workspace,
      toolContext: { permissions: agentConfig, workspace: cliOptions.workspace },
      mcpTools,
      dependencies: {
        executionConfig: agentConfig.agent?.execution,
      },
    });

    logStage("starting task runtime...");
    const runtimeService = new AgentRuntimeService(
      taskAgent,
      cliOptions.mode === "tui" ? { log: () => {} } : console,
    );
    runtimeService.start();

    return {
      runtimeService,
      disposeMCP: mcp.dispose,
    };
  } catch (error) {
    await mcp.dispose();
    throw error;
  }
};

const main = async () => {
  const startupStartTime = performance.now();
  const version = getAppVersion();
  const startupCwd = process.cwd();
  const cliOptions = parseCliOptions(process.argv.slice(2), startupCwd);

  if (cliOptions.mode === "tui-client") {
    printStartupBanner(DEFAULT_AGENT_NAME, version, cliOptions.mode);
    const serverUrl = buildServerUrl(cliOptions);
    console.log(`[tui] server = ${serverUrl}`);
    printTuiCommands();
    logStage(`ready in ${formatDuration(startupStartTime)}`);
    await startTuiClient({
      client: new HttpGatewayClient(serverUrl),
      serverUrl,
      mode: "tui-client",
      agentName: DEFAULT_AGENT_NAME,
    });
    return;
  }

  logStage("checking workspace...");
  await workspace_check(cliOptions.workspace);
  logStage("workspace ready");

  const todoCleanupResult = await cleanupTodoDbOnStartup({
    workspace: cliOptions.workspace,
  });
  if (todoCleanupResult.skipped) {
    logStage("todo cleanup skipped (no existing todo db)");
  } else {
    logStage(`todo cleanup removed ${todoCleanupResult.removed} file(s)`);
  }

  try {
    const cleanupResult = await cleanupInvalidBackgroundBashSessionsOnStartup({
      workspace: cliOptions.workspace,
    });
    if (cleanupResult.skipped) {
      logStage(`background session cleanup skipped (${cleanupResult.reason ?? "unknown reason"})`);
    } else if (cleanupResult.removed > 0) {
      logStage(
        `background session cleanup removed ${cleanupResult.removed} invalid session(s) (scanned ${cleanupResult.scanned})`,
      );
    }
  } catch (error) {
    console.warn(
      `[startup] background session cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logStage("loading agent config...");
  const agentConfig = await loadAgentConfig({
    workspace: cliOptions.workspace,
    configPath: cliOptions.configPath,
  });
  logStage("agent config loaded");
  const agentName = resolveAgentName(agentConfig.agent?.name);

  printStartupBanner(agentName, version, cliOptions.mode);
  printModelSelection(agentConfig);

  const { runtimeService, disposeMCP } = await initializeRuntimeService(
    cliOptions,
    agentConfig,
  );
  const gateway = startHttpGateway({
    runtime: runtimeService,
    host: cliOptions.httpHost,
    port: cliOptions.httpPort,
    appName: agentName,
    version,
    startupAt: runtimeService.startupAt,
  });

  console.log(`[http] listening on ${gateway.baseUrl}`);

  const shutdown = createShutdownController(async () => {
    gateway.stop();
    runtimeService.stop();
    await disposeMCP();
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
      mode: "tui",
      agentName,
      themeName: agentConfig.tui?.theme,
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
