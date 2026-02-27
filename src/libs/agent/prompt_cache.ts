import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const AGENT_FILENAME = "AGENT.md";
const AGENT_CACHE_DIR = ".agent";
const COMPILED_PROMPT_FILENAME = "compiled_prompt.md";
const COMPILED_PROMPT_META_FILENAME = "compiled_prompt.meta.json";
const PROMPT_META_VERSION = 1;

type CompiledPromptMeta = {
  version: number;
  agentChecksum: string;
  compiledAt: number;
};

export type PromptCacheSource = "cache" | "compiled";

export type LoadOrCompileSystemPromptResult = {
  systemPrompt: string;
  source: PromptCacheSource;
  checksum: string;
};

type LoadOrCompileSystemPromptArgs = {
  workspace: string;
  compileSystemPrompt: () => Promise<string>;
};

type AgentPromptWatcherArgs = {
  workspace: string;
  initialChecksum: string;
  compileSystemPrompt: () => Promise<string>;
  onPromptCompiled: (payload: { systemPrompt: string; checksum: string }) => Promise<void> | void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  debounceMs?: number;
};

const getAgentFilePath = (workspace: string) => join(workspace, AGENT_FILENAME);
const getPromptCacheDirPath = (workspace: string) => join(workspace, AGENT_CACHE_DIR);
const getCompiledPromptPath = (workspace: string) =>
  join(getPromptCacheDirPath(workspace), COMPILED_PROMPT_FILENAME);
const getCompiledPromptMetaPath = (workspace: string) =>
  join(getPromptCacheDirPath(workspace), COMPILED_PROMPT_META_FILENAME);

const toChecksum = (content: string) => createHash("sha256").update(content).digest("hex");

const readAgentChecksum = async (workspace: string): Promise<string> => {
  const content = await readFile(getAgentFilePath(workspace), "utf8");
  return toChecksum(content);
};

const parseCompiledPromptMeta = (raw: string): CompiledPromptMeta | null => {
  try {
    const parsed = JSON.parse(raw) as CompiledPromptMeta;
    if (
      parsed.version !== PROMPT_META_VERSION ||
      typeof parsed.agentChecksum !== "string" ||
      parsed.agentChecksum.length === 0 ||
      typeof parsed.compiledAt !== "number" ||
      !Number.isFinite(parsed.compiledAt)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

const writeFileAtomically = async (filepath: string, content: string) => {
  const tmpPath = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filepath);
};

const persistCompiledPrompt = async (args: {
  workspace: string;
  systemPrompt: string;
  checksum: string;
}) => {
  const cacheDir = getPromptCacheDirPath(args.workspace);
  await mkdir(cacheDir, { recursive: true });

  const compiledPromptPath = getCompiledPromptPath(args.workspace);
  const metaPath = getCompiledPromptMetaPath(args.workspace);
  await writeFileAtomically(compiledPromptPath, args.systemPrompt);
  await writeFileAtomically(
    metaPath,
    JSON.stringify(
      {
        version: PROMPT_META_VERSION,
        agentChecksum: args.checksum,
        compiledAt: Date.now(),
      } satisfies CompiledPromptMeta,
      null,
      2,
    ),
  );
};

const tryReadCachedPrompt = async (workspace: string, checksum: string): Promise<string | null> => {
  try {
    const [metaRaw, promptRaw] = await Promise.all([
      readFile(getCompiledPromptMetaPath(workspace), "utf8"),
      readFile(getCompiledPromptPath(workspace), "utf8"),
    ]);
    const meta = parseCompiledPromptMeta(metaRaw);
    if (!meta || meta.agentChecksum !== checksum) {
      return null;
    }

    return promptRaw;
  } catch {
    return null;
  }
};

export const loadOrCompileSystemPrompt = async (
  args: LoadOrCompileSystemPromptArgs,
): Promise<LoadOrCompileSystemPromptResult> => {
  const checksum = await readAgentChecksum(args.workspace);
  const cachedPrompt = await tryReadCachedPrompt(args.workspace, checksum);
  if (cachedPrompt) {
    return {
      systemPrompt: cachedPrompt,
      source: "cache",
      checksum,
    };
  }

  const systemPrompt = await args.compileSystemPrompt();
  await persistCompiledPrompt({
    workspace: args.workspace,
    systemPrompt,
    checksum,
  });
  return {
    systemPrompt,
    source: "compiled",
    checksum,
  };
};

export const createAgentPromptWatcher = (args: AgentPromptWatcherArgs) => {
  const debounceMs = args.debounceMs ?? 300;
  let watcher: FSWatcher | null = null;
  let lastChecksum = args.initialChecksum;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let pending = false;
  let stopRequested = false;
  let idleResolver: (() => void) | null = null;
  let idlePromise: Promise<void> | null = null;

  const clearDebounceTimer = () => {
    if (!debounceTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const ensureIdlePromise = () => {
    if (!idlePromise) {
      idlePromise = new Promise<void>((resolve) => {
        idleResolver = resolve;
      });
    }
    return idlePromise;
  };

  const resolveIdle = () => {
    idleResolver?.();
    idleResolver = null;
    idlePromise = null;
  };

  const runReload = async () => {
    if (processing || stopRequested) return;
    processing = true;

    try {
      while (pending && !stopRequested) {
        pending = false;
        const checksum = await readAgentChecksum(args.workspace);
        if (checksum === lastChecksum) {
          continue;
        }

        try {
          const systemPrompt = await args.compileSystemPrompt();
          await persistCompiledPrompt({
            workspace: args.workspace,
            systemPrompt,
            checksum,
          });
          await args.onPromptCompiled({
            systemPrompt,
            checksum,
          });
          lastChecksum = checksum;
          args.log?.("prompt recompiled and applied");
        } catch (error) {
          args.warn?.(
            `prompt recompile failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      args.warn?.(
        `prompt watcher failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      processing = false;
      resolveIdle();
    }
  };

  const scheduleReload = () => {
    if (stopRequested) return;
    pending = true;
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runReload();
    }, debounceMs);
  };

  const handleFileEvent = (filename: string | Buffer | null) => {
    if (stopRequested) return;
    if (filename == null) {
      scheduleReload();
      return;
    }

    const normalized = typeof filename === "string" ? filename : filename.toString("utf8");
    if (!normalized || basename(normalized) !== AGENT_FILENAME) {
      return;
    }

    scheduleReload();
  };

  return {
    start() {
      if (watcher || stopRequested) return;
      watcher = watch(args.workspace, { persistent: false }, (_eventType, filename) => {
        handleFileEvent(filename);
      });
      watcher.on("error", (error) => {
        args.warn?.(`prompt watcher fs error: ${error.message}`);
      });
    },
    async stop() {
      stopRequested = true;
      clearDebounceTimer();
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (processing) {
        await ensureIdlePromise();
      }
    },
  };
};
