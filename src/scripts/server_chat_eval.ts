import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type TaskSnapshot = {
  id: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  result?: string;
  error?: {
    message: string;
  };
};

type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8789;
const DEFAULT_WORKSPACE = "./Playground";
const POLL_INTERVAL_MS = 1000;
const TASK_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

const parseJson = async <T>(response: Response): Promise<ApiResponse<T>> => {
  const payload = await response.json() as ApiResponse<T>;
  return payload;
};

const request = async <T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const payload = await parseJson<T>(response);
  if (!response.ok || payload.ok !== true) {
    if (payload.ok === false) {
      throw new Error(`${payload.error.code}: ${payload.error.message}`);
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return payload.data;
};

const createTask = async (baseUrl: string, input: string) => {
  return await request<{ taskId: string }>(baseUrl, "/v1/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input,
    }),
  });
};

const getTask = async (baseUrl: string, taskId: string) => {
  return await request<{ task: TaskSnapshot }>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
  });
};

const runTask = async (baseUrl: string, input: string) => {
  const { taskId } = await createTask(baseUrl, input);
  const start = Date.now();

  while (Date.now() - start < TASK_TIMEOUT_MS) {
    const { task } = await getTask(baseUrl, taskId);
    if (task.status === "success") {
      return task.result ?? "";
    }
    if (task.status === "failed" || task.status === "cancelled") {
      throw new Error(
        `Task failed (${task.status}): ${task.error?.message ?? "unknown error"}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Task timeout after ${TASK_TIMEOUT_MS}ms: ${taskId}`);
};

const ensureHealth = async (baseUrl: string) => {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      await request(baseUrl, "/healthz", {
        method: "GET",
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Server health check timeout after ${HEALTH_TIMEOUT_MS}ms`);
};

const startServer = (workspace: string, port: number): ChildProcessWithoutNullStreams => {
  const child = spawn(
    "bun",
    [
      "run",
      "src/index.ts",
      "--mode",
      "server",
      "--workspace",
      workspace,
      "--http-host",
      HOST,
      "--http-port",
      String(port),
    ],
    {
      cwd: resolve("."),
      stdio: "pipe",
    },
  );

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[server:err] ${chunk.toString()}`);
  });

  return child;
};

const stopServer = async (child: ChildProcessWithoutNullStreams | null) => {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), 8_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });

  if (!exited) {
    child.kill("SIGKILL");
  }
};

const assertMatch = (name: string, actual: string, expected: RegExp) => {
  if (!expected.test(actual)) {
    throw new Error(
      `[${name}] assertion failed.\nExpected: ${expected}\nActual: ${actual}`,
    );
  }
  console.log(`[pass] ${name}`);
};

const cleanMemoryDb = async (workspace: string) => {
  const base = resolve(workspace, ".agent", "memory.db");
  await rm(base, { force: true });
  await rm(`${base}-shm`, { force: true });
  await rm(`${base}-wal`, { force: true });
};

const readMemoryStats = async (baseUrl: string) => {
  try {
    const stats = await request<{
      total: number;
      active: number;
      tag_ref: number;
      by_tier: {
        core: number;
        longterm: number;
      };
    }>(baseUrl, "/v1/agent/memory/stats", { method: "GET" });
    console.log(
      `[memory] total=${stats.total}, active=${stats.active}, tag_ref=${stats.tag_ref}, core=${stats.by_tier.core}, longterm=${stats.by_tier.longterm}`,
    );
  } catch (error) {
    console.warn(`[warn] memory stats unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const main = async () => {
  const workspace = process.argv[2] ?? DEFAULT_WORKSPACE;
  const port = Number(process.argv[3] ?? DEFAULT_PORT);
  const keepDb = process.argv.includes("--keep-db");
  const baseUrl = `http://${HOST}:${port}`;

  if (!keepDb) {
    await cleanMemoryDb(workspace);
  }

  const code = `alpha-${Date.now().toString(36)}`;
  const place = `Hangar-${Math.random().toString(36).slice(2, 8)}`;
  let server: ChildProcessWithoutNullStreams | null = null;

  try {
    console.log(`[setup] workspace=${resolve(workspace)} port=${port}`);
    server = startServer(workspace, port);
    await ensureHealth(baseUrl);
    console.log("[setup] server is healthy");

    const q1 = `请记住这条信息并先回复“已记住”：暗号=${code}，常去地点=${place}。`;
    const q2 = "上一个任务让我记住的暗号是什么？只输出暗号本身。";
    const q3 = "我常去的地点叫什么？只输出地点名。";
    const q4 = "请记住：google 的网址是 https://www.google.com，并回复 ok。";
    const q5 = "google 的网址是什么？只输出 URL。";

    const a1 = await runTask(baseUrl, q1);
    assertMatch("Q1 ack", a1, /已记住|ok|OK|记住/);

    const a2 = await runTask(baseUrl, q2);
    assertMatch("Q2 code recall", a2, new RegExp(code));

    const a3 = await runTask(baseUrl, q3);
    assertMatch("Q3 place recall", a3, new RegExp(place));

    const a4 = await runTask(baseUrl, q4);
    assertMatch("Q4 website save", a4, /ok|OK|已记住|记住/);

    const a5 = await runTask(baseUrl, q5);
    assertMatch("Q5 website recall (same process)", a5, /https?:\/\/(www\.)?google\.com/i);

    await readMemoryStats(baseUrl);

    console.log("[phase] restarting server to validate persistent memory...");
    await stopServer(server);
    server = startServer(workspace, port);
    await ensureHealth(baseUrl);

    const a6 = await runTask(baseUrl, q5);
    assertMatch("Q6 website recall (after restart)", a6, /https?:\/\/(www\.)?google\.com/i);

    await readMemoryStats(baseUrl);
    console.log("\nAll checks passed.");
  } finally {
    await stopServer(server);
  }
};

main().catch((error) => {
  console.error(`\n[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
