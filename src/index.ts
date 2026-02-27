/* Runtime */
import { join } from "node:path";
import { readFileSync } from "node:fs";

/* Framework */
import { bootstrap } from "./libs/agent/boot";
import { workspace_check } from "./libs/utils/workspace_check";
import { Agent } from "./libs/agent/agent";
import { loadAgentConfig, resolveTelegramConfig } from "./libs/agent/config";
import {
  createLanguageModelFromAgentConfig,
  isOpenAICompatibleProvider,
  resolveSelectedProvider,
  resolveOpenAICompatibleProviderBaseURL,
} from "./libs/agent/providers/factory";
import { parseCliOptions, type CliOptions } from "./libs/utils/cli";
import { initMCPTools } from "./libs/mcp";
import { createMCPHealthStatusProvider } from "./libs/mcp/health";
import { AgentRuntimeService } from "./libs/runtime";
import { HttpGatewayClient, startHttpGateway } from "./libs/channel";
import { startTelegramClient, startTuiClient } from "./clients";
import { cleanupInvalidBackgroundBashSessionsOnStartup } from "./libs/agent/tools/background_sessions";
import { cleanupTodoDbOnStartup } from "./libs/agent/tools/todo_store";
import { PersistentMemoryCoordinator } from "./libs/agent/memory";
import { createAgentPromptWatcher, loadOrCompileSystemPrompt } from "./libs/agent/prompt_cache";

declare const BUILD_VERSION: string | undefined;

const DEFAULT_AGENT_NAME = "Atom";
const HELP_TEXT = `Usage: atom [options]

Options:
  --help, -h                    Show this help message
  --version, -v                 Show version information
  --workspace <path>            Workspace directory (default: .)
  --config <path>               Path to agent config file
  --mode <mode>                 Run mode:
                                tui | server | tui-client | telegram | telegram-client
                                (legacy alias: hybrid -> tui)
  --http-host <host>            HTTP host (default: 127.0.0.1)
  --http-port <port>            HTTP port (default: 8787)
  --server-url <url>            Server URL (for tui-client/telegram-client)

Examples:
  bun run src/index.ts --workspace ./Playground
  bun run src/index.ts --mode server --workspace ./Playground
  bun run src/index.ts --mode tui-client --server-url http://127.0.0.1:8787
`;

const getAppVersion = (): string => {
  if (typeof BUILD_VERSION === "string") {
    const bundledVersion = BUILD_VERSION.trim();
    if (bundledVersion.length > 0) {
      return bundledVersion;
    }
  }

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

const printVersionInfo = (version: string) => {
  const bunVersion = process.versions.bun ?? "unknown";
  const nodeVersion = process.versions.node ?? "unknown";
  console.log(`Atom v${version}`);
  console.log(`bun ${bunVersion}`);
  console.log(`node ${nodeVersion}`);
  console.log(`${process.platform} ${process.arch}`);
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

const printStartupReady = (startTime: number) => {
  logStage(`ready (${formatDuration(startTime)})`);
};

const printTelegramConfigSummary = (
  telegramConfig: ReturnType<typeof resolveTelegramConfig>,
) => {
  if (!telegramConfig) return;
  console.log(
    `[telegram.config] transport=${telegramConfig.transport.type} | allowed_chat_id=${telegramConfig.allowedChatId} | parse_mode=${telegramConfig.message.parseMode} | chunk_size=${telegramConfig.message.chunkSize}`,
  );
  console.log(
    `[telegram.config] polling_interval_ms=${telegramConfig.transport.pollingIntervalMs} | long_poll_timeout_sec=${telegramConfig.transport.longPollTimeoutSec} | drop_pending_updates_on_start=${telegramConfig.transport.dropPendingUpdatesOnStart}`,
  );
};

const resolveRequiredTelegramConfig = (
  config: Awaited<ReturnType<typeof loadAgentConfig>>,
) => {
  const telegramConfig = resolveTelegramConfig(config);
  if (!telegramConfig) {
    throw new Error(
      "telegram config is required for telegram modes. Add `telegram` in agent.config.json",
    );
  }

  return telegramConfig;
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
  logStage("initializing MCP servers...");
  const mcp = await initMCPTools(agentConfig.mcp);
  const { tools: mcpTools, status: mcpStatus } = mcp;

  const mcpAvailableCount = mcpStatus.filter((status) => status.available).length;
  logStage(`MCP ready (${mcpAvailableCount}/${mcpStatus.length})`);

  let persistentMemoryCoordinator: PersistentMemoryCoordinator | undefined;
  let stopPromptWatcher: (() => Promise<void>) | undefined;

  try {
    const model = createLanguageModelFromAgentConfig(agentConfig);
    const agentPromptFilePath = join(cliOptions.workspace, "AGENT.md");

    const compileSystemPrompt = async () => {
      const { systemPrompt } = await bootstrap(model)({
        userPromptFilePath: agentPromptFilePath,
        enableOptimization: true,
      });
      return systemPrompt;
    };

    const promptLoadResult = await loadOrCompileSystemPrompt({
      workspace: cliOptions.workspace,
      compileSystemPrompt: async () => {
        logStage("prompt cache miss, compiling...");
        return await compileSystemPrompt();
      },
    });
    if (promptLoadResult.source === "cache") {
      logStage("prompt cache hit");
    } else {
      logStage("prompt compiled and cached");
    }

    logStage("creating agent...");
    const activePersistentMemoryCoordinator = PersistentMemoryCoordinator.initialize({
      workspace: cliOptions.workspace,
      config: agentConfig.memory?.persistent,
    });
    persistentMemoryCoordinator = activePersistentMemoryCoordinator;
    const persistentMemoryStatus = activePersistentMemoryCoordinator.status;
    if (persistentMemoryStatus.enabled && persistentMemoryStatus.available) {
      console.log(
        `[memory] persistent enabled | db=${persistentMemoryStatus.dbPath} | search=${persistentMemoryStatus.searchModeUsed ?? "like"}`,
      );
    } else if (persistentMemoryStatus.enabled) {
      console.warn(
        `[memory] persistent unavailable, disabled for this run | ${persistentMemoryStatus.message ?? "unknown error"}`,
      );
    }

    const taskAgent = new Agent({
      systemPrompt: promptLoadResult.systemPrompt,
      model,
      modelParams: agentConfig.agent?.params,
      workspace: cliOptions.workspace,
      toolContext: {
        permissions: agentConfig,
        workspace: cliOptions.workspace,
        persistentMemoryCoordinator: activePersistentMemoryCoordinator,
      },
      mcpTools,
      dependencies: {
        executionConfig: agentConfig.agent?.execution,
        persistentMemoryHooks: activePersistentMemoryCoordinator.hooks,
      },
    });

    logStage("starting task runtime...");
    const runtimeService = new AgentRuntimeService(
      taskAgent,
      cliOptions.mode === "tui" ? { log: () => {} } : console,
      {
        persistentMemoryCoordinator: activePersistentMemoryCoordinator,
      },
    );
    runtimeService.start();
    const getMcpStatus = createMCPHealthStatusProvider({
      startupStatus: mcpStatus,
    });

    const promptWatcher = createAgentPromptWatcher({
      workspace: cliOptions.workspace,
      initialChecksum: promptLoadResult.checksum,
      compileSystemPrompt,
      onPromptCompiled: ({ systemPrompt }) => {
        runtimeService.updateSystemPrompt(systemPrompt);
      },
      log: (message) => logStage(message),
      warn: (message) => console.warn(`[startup] ${message}`),
    });
    promptWatcher.start();
    stopPromptWatcher = async () => {
      await promptWatcher.stop();
    };
    logStage("prompt watch enabled");

    return {
      runtimeService,
      getMcpStatus,
      disposePromptWatcher: stopPromptWatcher ?? (async () => {}),
      disposePersistentMemory: () => activePersistentMemoryCoordinator.dispose(),
      disposeMCP: mcp.dispose,
    };
  } catch (error) {
    await stopPromptWatcher?.();
    await persistentMemoryCoordinator?.dispose();
    await mcp.dispose();
    throw error;
  }
};

const main = async () => {
  const startupStartTime = performance.now();
  const version = getAppVersion();
  const startupCwd = process.cwd();
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    printVersionInfo(version);
    return;
  }
  const cliOptions = parseCliOptions(argv, startupCwd);

  if (cliOptions.mode === "tui-client") {
    printStartupBanner(DEFAULT_AGENT_NAME, version, cliOptions.mode);
    const serverUrl = buildServerUrl(cliOptions);
    console.log(`[tui] server = ${serverUrl}`);
    printStartupReady(startupStartTime);
    await startTuiClient({
      client: new HttpGatewayClient(serverUrl),
      serverUrl,
      mode: "tui-client",
      agentName: DEFAULT_AGENT_NAME,
      version,
    });
    return;
  }

  if (cliOptions.mode === "telegram-client") {
    logStage("loading agent config...");
    const agentConfig = await loadAgentConfig({
      workspace: cliOptions.workspace,
      configPath: cliOptions.configPath,
    });
    logStage("agent config loaded");
    const agentName = resolveAgentName(agentConfig.agent?.name);
    printStartupBanner(agentName, version, cliOptions.mode);

    const serverUrl = buildServerUrl(cliOptions);
    const telegramConfig = resolveRequiredTelegramConfig(agentConfig);
    printTelegramConfigSummary(telegramConfig);
    console.log(`[telegram] server = ${serverUrl}`);
    printStartupReady(startupStartTime);
    await startTelegramClient({
      client: new HttpGatewayClient(serverUrl),
      config: telegramConfig,
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

  const { runtimeService, getMcpStatus, disposeMCP, disposePersistentMemory, disposePromptWatcher } =
    await initializeRuntimeService(
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
    getMcpStatus,
  });

  console.log(`[http] listening on ${gateway.baseUrl}`);

  const shutdown = createShutdownController(async () => {
    gateway.stop();
    runtimeService.stop();
    await disposePromptWatcher();
    await disposePersistentMemory();
    await disposeMCP();
  });

  printStartupReady(startupStartTime);

  if (cliOptions.mode === "server") {
    await shutdown.wait;
    shutdown.dispose();
    return;
  }

  if (cliOptions.mode === "tui") {
    try {
      await startTuiClient({
        client: new HttpGatewayClient(gateway.baseUrl),
        serverUrl: gateway.baseUrl,
        mode: "tui",
        agentName,
        version,
        themeName: agentConfig.tui?.theme,
      });
    } finally {
      await shutdown.run("tui exit");
      shutdown.dispose();
    }
    return;
  }

  const telegramConfig = resolveRequiredTelegramConfig(agentConfig);
  printTelegramConfigSummary(telegramConfig);
  try {
    await startTelegramClient({
      client: new HttpGatewayClient(gateway.baseUrl),
      config: telegramConfig,
    });
  } finally {
    await shutdown.run("telegram exit");
    shutdown.dispose();
  }
};

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[startup] failed: ${message}`);
  process.exit(1);
});
