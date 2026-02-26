import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { backgroundTool } from "./background";
import { cleanupInvalidBackgroundBashSessionsOnStartup } from "./background_sessions";
import {
  resetBashToolAvailabilityCacheForTest,
  setBashAvailabilityCacheForTest,
  setTmuxAvailabilityCacheForTest,
} from "./bash_utils";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-background-tool-test-"));
};

const executeTool = async (context: Record<string, unknown>, input: unknown) =>
  await (backgroundTool(context as any) as any).execute(input);

const encodeLogLine = (seq: number, ts: number, stream: "stdout" | "stderr" | "meta", text: string) =>
  `v1\t${seq}\t${ts}\t${stream}\t${Buffer.from(text, "utf8").toString("base64")}\n`;

const writeBackgroundSession = async (args: {
  workspace: string;
  sessionId: string;
  cwd?: string;
  command?: string;
  logLines?: string[];
}) => {
  const stateDir = join(args.workspace, ".agent", "background");
  await mkdir(stateDir, { recursive: true });

  const sessionId = args.sessionId;
  const cwd = args.cwd ?? args.workspace;
  const logFile = join(stateDir, `${sessionId}.log`);
  const metadataFile = join(stateDir, `${sessionId}.json`);
  const cmdScriptFile = join(stateDir, `${sessionId}.cmd.sh`);
  const runnerScriptFile = join(stateDir, `${sessionId}.runner.sh`);

  if (args.logLines) {
    await writeFile(logFile, args.logLines.join(""), "utf8");
  }

  await writeFile(
    metadataFile,
    JSON.stringify(
      {
        sessionId,
        tool: "background",
        cwd,
        command: args.command ?? "echo hello",
        tmuxSessionName: `atom-bash-${sessionId}`,
        startedAt: 1000,
        updatedAt: 1000,
        logFile,
        cmdScriptFile,
        runnerScriptFile,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { stateDir, logFile, metadataFile };
};

afterEach(() => {
  resetBashToolAvailabilityCacheForTest();
});

describe("background tool", () => {
  test("start returns clear error when tmux is unavailable", async () => {
    const cwd = await createWorkspaceTempDir();
    setBashAvailabilityCacheForTest(true);
    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        cwd,
        command: "echo hello",
        sessionId: "bg-no-tmux",
      },
    );

    expect(result.error).toBe("tmux command is not available in runtime environment");
  });

  test("start rejects missing cwd directory before tmux check", async () => {
    const workspace = await createWorkspaceTempDir();
    const missingCwd = join(workspace, "missing-dir");
    setBashAvailabilityCacheForTest(true);
    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      { workspace },
      {
        action: "start",
        cwd: missingCwd,
        command: "echo hello",
        sessionId: "bg-missing-cwd",
      },
    );

    expect(result.error).toBe("Invalid cwd");
    expect(result.detail).toBe("cwd directory does not exist");
  });

  test("query_logs reads per-session log file with offset cursor", async () => {
    const workspace = await createWorkspaceTempDir();
    const sessionId = "bg-query-file";
    await writeBackgroundSession({
      workspace,
      sessionId,
      logLines: [
        encodeLogLine(1, 1000, "meta", "start"),
        encodeLogLine(2, 1100, "stdout", "hello"),
        encodeLogLine(3, 1200, "stderr", "oops"),
        encodeLogLine(4, 1300, "meta", "exit:0"),
      ],
    });
    setTmuxAvailabilityCacheForTest(false);

    const first = await executeTool(
      { workspace },
      {
        action: "query_logs",
        sessionId,
        maxItems: 1,
      },
    );

    expect(first.mode).toBe("background");
    expect(first.items.length).toBe(1);
    expect(typeof first.nextCursor).toBe("string");
    expect(first.warning).toContain("tmux");

    const second = await executeTool(
      { workspace },
      {
        action: "query_logs",
        sessionId,
        cursor: first.nextCursor,
        maxItems: 10,
      },
    );

    expect(second.items.some((item: any) => item.stream === "stdout")).toBe(true);
    expect(second.items.some((item: any) => item.stream === "stderr")).toBe(true);
    expect(second.status).toBe("exited");
    expect(second.exitCode).toBe(0);
    expect(second.done).toBe(true);
  });

  test("inspect returns metadata and warning when tmux is unavailable", async () => {
    const workspace = await createWorkspaceTempDir();
    const sessionId = "bg-inspect-no-tmux";
    await writeBackgroundSession({ workspace, sessionId });
    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      { workspace },
      {
        action: "inspect",
        sessionId,
      },
    );

    expect(result.session.sessionId).toBe(sessionId);
    expect(Array.isArray(result.windows)).toBe(true);
    expect(Array.isArray(result.panes)).toBe(true);
    expect(result.windows.length).toBe(0);
    expect(result.panes.length).toBe(0);
    expect(result.warning).toContain("tmux");
  });

  test("list scans only .agent/background and ignores .agent/bash", async () => {
    const workspace = await createWorkspaceTempDir();
    const backgroundSessionId = "bg-listed";
    await writeBackgroundSession({ workspace, sessionId: backgroundSessionId });

    const oldBashDir = join(workspace, ".agent", "bash");
    await mkdir(oldBashDir, { recursive: true });
    await writeFile(
      join(oldBashDir, "legacy.json"),
      JSON.stringify({ sessionId: "legacy", cwd: workspace }, null, 2),
      "utf8",
    );

    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      { workspace },
      {
        action: "list",
      },
    );

    expect(result.sessions.some((session: any) => session.sessionId === backgroundSessionId)).toBe(true);
    expect(result.sessions.some((session: any) => session.sessionId === "legacy")).toBe(false);
  });

  test("list filters sessions by permissions.background", async () => {
    const workspace = await createWorkspaceTempDir();
    const allowedCwd = join(workspace, "allowed");
    const blockedCwd = join(workspace, "blocked");
    await mkdir(allowedCwd, { recursive: true });
    await mkdir(blockedCwd, { recursive: true });

    await writeBackgroundSession({ workspace, sessionId: "allowed", cwd: allowedCwd });
    await writeBackgroundSession({ workspace, sessionId: "blocked", cwd: blockedCwd });
    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      {
        workspace,
        permissions: {
          permissions: {
            background: {
              allow: [`^${allowedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?.*`],
            },
          },
        },
      },
      {
        action: "list",
      },
    );

    expect(result.sessions.some((session: any) => session.sessionId === "allowed")).toBe(true);
    expect(result.sessions.some((session: any) => session.sessionId === "blocked")).toBe(false);
  });

  test("send_keys/new_window/split_pane block dangerous commands", async () => {
    const workspace = await createWorkspaceTempDir();
    const sessionId = "bg-guard";
    await writeBackgroundSession({ workspace, sessionId });

    const sendKeysResult = await executeTool(
      { workspace },
      {
        action: "send_keys",
        sessionId,
        paneId: "%1",
        command: "echo ok && rm -rf /",
      },
    );
    expect(sendKeysResult.error).toBe("Command blocked by builtin safety policy");

    const newWindowResult = await executeTool(
      { workspace },
      {
        action: "new_window",
        sessionId,
        command: "shutdown now",
      },
    );
    expect(newWindowResult.error).toBe("Command blocked by builtin safety policy");

    const splitPaneResult = await executeTool(
      { workspace },
      {
        action: "split_pane",
        sessionId,
        targetPaneId: "%1",
        direction: "vertical",
        command: "mkfs.ext4 /dev/sda",
      },
    );
    expect(splitPaneResult.error).toBe("Command blocked by builtin safety policy");
  });

  test("new_window validates cwd existence", async () => {
    const workspace = await createWorkspaceTempDir();
    const sessionId = "bg-new-window-cwd-check";
    await writeBackgroundSession({ workspace, sessionId });

    const result = await executeTool(
      { workspace },
      {
        action: "new_window",
        sessionId,
        cwd: join(workspace, "missing-cwd"),
      },
    );

    expect(result.error).toBe("Invalid cwd");
    expect(result.detail).toBe("cwd directory does not exist");
  });

  test("send_keys safe command reaches tmux availability error after validation", async () => {
    const workspace = await createWorkspaceTempDir();
    const sessionId = "bg-send-keys-no-tmux";
    await writeBackgroundSession({ workspace, sessionId });
    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      { workspace },
      {
        action: "send_keys",
        sessionId,
        paneId: "%1",
        command: "echo safe",
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("tmux command is not available in runtime environment");
  });

  test("kill returns not_found for missing session", async () => {
    const workspace = await createWorkspaceTempDir();

    const result = await executeTool(
      { workspace },
      {
        action: "kill",
        sessionId: "missing-session",
      },
    );

    expect(result.status).toBe("not_found");
  });

  test("startup cleanup removes invalid unknown sessions and keeps exited sessions", async () => {
    const workspace = await createWorkspaceTempDir();

    const unknownSessionId = "bg-unknown-stale";
    const { logFile: unknownLogFile, metadataFile: unknownMetadataFile } = await writeBackgroundSession({
      workspace,
      sessionId: unknownSessionId,
      logLines: [
        encodeLogLine(1, 1000, "meta", "start"),
        encodeLogLine(2, 1100, "stdout", "partial"),
      ],
    });

    const exitedSessionId = "bg-exited-keep";
    const { logFile: exitedLogFile, metadataFile: exitedMetadataFile } = await writeBackgroundSession({
      workspace,
      sessionId: exitedSessionId,
      logLines: [
        encodeLogLine(1, 1000, "meta", "start"),
        encodeLogLine(2, 1200, "meta", "exit:0"),
      ],
    });

    // Force cleanup path to perform tmux session checks deterministically.
    setTmuxAvailabilityCacheForTest(true);

    const result = await cleanupInvalidBackgroundBashSessionsOnStartup({ workspace });

    expect(result.skipped).toBe(false);
    expect(result.removedSessionIds).toContain(unknownSessionId);
    expect(result.removedSessionIds).not.toContain(exitedSessionId);
    expect(await Bun.file(unknownMetadataFile).exists()).toBe(false);
    expect(await Bun.file(unknownLogFile).exists()).toBe(false);
    expect(await Bun.file(exitedMetadataFile).exists()).toBe(true);
    expect(await Bun.file(exitedLogFile).exists()).toBe(true);
  });
});
