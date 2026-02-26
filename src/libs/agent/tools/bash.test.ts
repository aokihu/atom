import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { bashTool } from "./bash";
import { resetNormalBashSessionsForTest } from "./bash_sessions";
import { resetBashToolAvailabilityCacheForTest } from "./bash_utils";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-bash-test-"));
};

const executeTool = async (context: Record<string, unknown>, input: unknown) =>
  await (bashTool(context as any) as any).execute(input);

const waitFor = async <T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
  intervalMs = 50,
) => {
  const start = Date.now();
  while (true) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

afterEach(async () => {
  resetBashToolAvailabilityCacheForTest();
  await resetNormalBashSessionsForTest();
});

describe("bash tool", () => {
  test("once mode runs command successfully", async () => {
    const cwd = await createWorkspaceTempDir();

    const result = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "once",
        cwd,
        command: "printf 'hello'",
      },
    );

    expect(result.mode).toBe("once");
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  test("once mode defaults cwd to workspace when omitted", async () => {
    const workspace = await createWorkspaceTempDir();

    const result = await executeTool(
      { workspace },
      {
        action: "start",
        mode: "once",
        command: "pwd",
      },
    );

    expect(result.mode).toBe("once");
    expect(result.success).toBe(true);
    expect(result.cwd).toBe(workspace);
    expect(result.stdout.trim()).toBe(workspace);
  });

  test("once mode returns non-zero exit without throwing", async () => {
    const cwd = await createWorkspaceTempDir();

    const result = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "once",
        cwd,
        command: "echo err >&2; exit 3",
      },
    );

    expect(result.mode).toBe("once");
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(typeof result.error).toBe("string");
    expect(result.stderr).toContain("err");
  });

  test("start rejects missing cwd directory", async () => {
    const workspace = await createWorkspaceTempDir();
    const missingCwd = join(workspace, "missing-dir");

    const result = await executeTool(
      { workspace },
      {
        action: "start",
        mode: "once",
        cwd: missingCwd,
        command: "echo hello",
      },
    );

    expect(result.error).toBe("Invalid cwd");
    expect(result.detail).toBe("cwd directory does not exist");
  });

  test("normal mode supports incremental query cursor and stream separation", async () => {
    const cwd = await createWorkspaceTempDir();
    const startResult = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "normal",
        cwd,
        command: "echo out1; echo err1 >&2; sleep 0.1; echo out2",
        sessionId: "normal-query-test",
      },
    );

    expect(startResult.status).toBe("running");
    expect(startResult.mode).toBe("normal");

    const firstQuery = await waitFor(
      async () =>
        await executeTool(
          { workspace: cwd },
          {
            action: "query",
            sessionId: "normal-query-test",
            maxItems: 1,
          },
        ),
      (value) => Array.isArray((value as any).items) && (value as any).items.length === 1,
    );

    expect(firstQuery.items.length).toBe(1);
    expect(typeof firstQuery.nextCursor).toBe("string");

    const secondQuery = await waitFor(
      async () =>
        await executeTool(
          { workspace: cwd },
          {
            action: "query",
            sessionId: "normal-query-test",
            cursor: firstQuery.nextCursor,
            maxItems: 20,
          },
        ),
      (value) => Array.isArray((value as any).items) && (value as any).items.length > 0,
    );

    for (const item of secondQuery.items) {
      expect(item.seq).toBeGreaterThan(firstQuery.items[0].seq);
    }

    let cursor = secondQuery.nextCursor as string;
    const allItems = [...firstQuery.items, ...secondQuery.items];
    let lastQuery = secondQuery;

    lastQuery = await waitFor(
      async () => {
        const next = await executeTool(
          { workspace: cwd },
          {
            action: "query",
            sessionId: "normal-query-test",
            cursor,
            maxItems: 20,
          },
        );
        cursor = next.nextCursor ?? cursor;
        allItems.push(...(next.items ?? []));
        return next;
      },
      (value) => (value as any).done === true,
      5_000,
      50,
    );

    expect(allItems.some((item) => item.stream === "stdout")).toBe(true);
    expect(allItems.some((item) => item.stream === "stderr")).toBe(true);
    expect(lastQuery.done).toBe(true);
  });

  test("normal mode idle timeout terminates inactive process", async () => {
    const cwd = await createWorkspaceTempDir();
    const startResult = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "normal",
        cwd,
        command: "sleep 5",
        sessionId: "idle-timeout-test",
        idleTimeoutMs: 100,
      },
    );

    expect(startResult.status).toBe("running");

    const finalQuery = await waitFor(
      async () =>
        await executeTool(
          { workspace: cwd },
          {
            action: "query",
            sessionId: "idle-timeout-test",
            maxItems: 50,
          },
        ),
      (value) => (value as any).status === "idle_timeout" || (value as any).done === true,
      10_000,
      100,
    );

    expect(finalQuery.status).toBe("idle_timeout");
    expect(finalQuery.done).toBe(true);
  });

  test("normal mode kill is idempotent", async () => {
    const cwd = await createWorkspaceTempDir();
    const startResult = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "normal",
        cwd,
        command: "sleep 5",
        sessionId: "kill-normal-test",
      },
    );

    expect(startResult.status).toBe("running");

    const killResult = await executeTool(
      { workspace: cwd },
      {
        action: "kill",
        sessionId: "kill-normal-test",
      },
    );

    expect(killResult.success).toBe(true);
    expect(killResult.status).toBe("killed");

    const killAgainResult = await executeTool(
      { workspace: cwd },
      {
        action: "kill",
        sessionId: "kill-normal-test",
      },
    );

    expect(killAgainResult.success).toBe(true);
    expect(killAgainResult.status).toBe("already_exited");
  });

  test("background mode returns migration error", async () => {
    const cwd = await createWorkspaceTempDir();

    const result = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "background",
        cwd,
        command: "echo hello",
      },
    );

    expect(result.error).toBe("bash background mode has been removed");
    expect(result.hint).toBe("Use the 'background' tool instead");
  });

  test("query and kill do not read background tool sessions", async () => {
    const workspace = await createWorkspaceTempDir();
    const stateDir = join(workspace, ".agent", "background");
    await mkdir(stateDir, { recursive: true });

    const sessionId = "bg-owned-by-background-tool";
    await Bun.write(
      join(stateDir, `${sessionId}.json`),
      JSON.stringify(
        {
          sessionId,
          tool: "background",
          cwd: workspace,
          command: "echo hi",
          tmuxSessionName: "atom-bash-test-ignored",
          startedAt: Date.now(),
          logFile: join(stateDir, `${sessionId}.log`),
          cmdScriptFile: join(stateDir, `${sessionId}.cmd.sh`),
          runnerScriptFile: join(stateDir, `${sessionId}.runner.sh`),
        },
        null,
        2,
      ),
    );

    const queryResult = await executeTool(
      { workspace },
      {
        action: "query",
        sessionId,
      },
    );
    expect(queryResult.status).toBe("not_found");

    const killResult = await executeTool(
      { workspace },
      {
        action: "kill",
        sessionId,
      },
    );
    expect(killResult.status).toBe("not_found");
  });
});
