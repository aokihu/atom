import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../session/agent_session";
import { PersistentMemoryCoordinator } from "./persistent_coordinator";

const createSession = (workspace: string) =>
  new AgentSession({
    workspace,
    systemPrompt: "system prompt",
  });

describe("persistent_coordinator", () => {
  test("filters recall blocks from recapture and canonicalizes ids", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atom-persistent-"));

    const coordinator = new PersistentMemoryCoordinator({
      workspace,
      memoryConfig: {
        persistent: {
          enabled: true,
          storagePath: join(workspace, ".agent", "persistent-memory.jsonl"),
          walPath: join(workspace, ".agent", "memory-queue.wal"),
          pipeline: {
            mode: "sync",
          },
        },
      },
    });
    await coordinator.initialize();

    const session = createSession(workspace);
    session.beginTaskContext({
      id: "task-1",
      type: "tui.input",
      input: "hello",
      retries: 0,
      startedAt: Date.now(),
    });

    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "working:abc",
            type: "task",
            decay: 0.2,
            confidence: 0.95,
            round: 1,
            tags: ["task"],
            content: "first",
          },
        ],
      },
    } as any);

    await coordinator.afterTask(session);

    const storagePath = join(workspace, ".agent", "persistent-memory.jsonl");
    const beforeRecall = (await readFile(storagePath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    expect(beforeRecall).toHaveLength(1);
    expect(beforeRecall[0]).toContain("\"blockId\":\"working:abc\"");

    session.finishTaskContext({
      id: "task-1",
      type: "tui.input",
      status: "success",
      finishedAt: Date.now(),
      retries: 0,
      attempts: 1,
    });

    await coordinator.beforeTask(session);
    const context = session.getContextSnapshot();
    expect(context.memory.longterm.some((item) => item.type === "persistent_longterm_recall")).toBe(true);

    await coordinator.afterTask(session);
    const afterRecall = (await readFile(storagePath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    expect(afterRecall).toHaveLength(1);

    await coordinator.dispose();
    await rm(workspace, { recursive: true, force: true });
  });
});
