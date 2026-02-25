import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { bashTool } from "./bash";
import {
  resetBashToolAvailabilityCacheForTest,
  setBashAvailabilityCacheForTest,
  setTmuxAvailabilityCacheForTest,
} from "./bash_utils";

const createWorkspaceTempDir = async () => {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "atom-bash-bg-test-"));
};

const executeTool = async (context: Record<string, unknown>, input: unknown) =>
  await (bashTool(context as any) as any).execute(input);

const encodeLogLine = (seq: number, ts: number, stream: "stdout" | "stderr" | "meta", text: string) =>
  `v1\t${seq}\t${ts}\t${stream}\t${Buffer.from(text, "utf8").toString("base64")}\n`;

afterEach(() => {
  resetBashToolAvailabilityCacheForTest();
});

describe("bash background mode", () => {
  test("returns clear error when tmux is unavailable", async () => {
    const cwd = await createWorkspaceTempDir();
    setBashAvailabilityCacheForTest(true);
    setTmuxAvailabilityCacheForTest(false);

    const result = await executeTool(
      { workspace: cwd },
      {
        action: "start",
        mode: "background",
        cwd,
        command: "echo hello",
        sessionId: "bg-no-tmux",
      },
    );

    expect(result.error).toBe("tmux command is not available in runtime environment");
  });

  test("queries per-session log file with offset cursor and no shared log file", async () => {
    const workspace = await createWorkspaceTempDir();
    const stateDir = join(workspace, ".agent", "bash");
    await mkdir(stateDir, { recursive: true });

    const sessionId = "bg-query-file";
    const logFile = join(stateDir, `${sessionId}.log`);
    const metadataFile = join(stateDir, `${sessionId}.json`);
    const cmdScriptFile = join(stateDir, `${sessionId}.cmd.sh`);
    const runnerScriptFile = join(stateDir, `${sessionId}.runner.sh`);

    await writeFile(
      logFile,
      [
        encodeLogLine(1, 1000, "meta", "start"),
        encodeLogLine(2, 1100, "stdout", "hello"),
        encodeLogLine(3, 1200, "stderr", "oops"),
        encodeLogLine(4, 1300, "meta", "exit:0"),
      ].join(""),
      "utf8",
    );

    await writeFile(
      metadataFile,
      JSON.stringify(
        {
          sessionId,
          mode: "background",
          cwd: workspace,
          command: "echo hello",
          tmuxSessionName: "atom-bash-bg-query-file",
          startedAt: 1000,
          logFile,
          cmdScriptFile,
          runnerScriptFile,
        },
        null,
        2,
      ),
      "utf8",
    );

    setTmuxAvailabilityCacheForTest(false);

    const first = await executeTool(
      { workspace },
      {
        action: "query",
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
        action: "query",
        sessionId,
        cursor: first.nextCursor,
        maxItems: 10,
      },
    );

    expect(second.items.every((item: any) => item.seq > first.items[0].seq)).toBe(true);
    expect(second.status).toBe("exited");
    expect(second.exitCode).toBe(0);
    expect(second.done).toBe(true);
    expect(second.items.some((item: any) => item.stream === "stdout")).toBe(true);
    expect(second.items.some((item: any) => item.stream === "stderr")).toBe(true);

    const sharedLog = join(workspace, ".agent", "tmux_sessions.log");
    const sharedExists = await Bun.file(sharedLog).exists();
    expect(sharedExists).toBe(false);
  });
});

