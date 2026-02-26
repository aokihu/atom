import { describe, expect, test } from "bun:test";
import { AgentSession } from "./agent_session";
import { CONTEXT_POLICY } from "./context_policy";

const createClock = () => {
  let tick = 0;
  return {
    nowTimestamp: () => 1700000000000 + ++tick,
    nowDatetime: () => `2026-02-23 10:00:0${++tick}`,
  };
};

describe("AgentSession", () => {
  test("injects context before first user turn and keeps original system prompt", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.prepareUserTurn("hello");

    const snapshot = session.snapshot();
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[0]?.role).toBe("system");
    expect(String(snapshot.messages[0]?.content)).toContain("<context>");
    expect(snapshot.messages[1]?.content).toBe("system prompt");
    expect(snapshot.messages[2]?.content).toBe("hello");
    expect(snapshot.context.runtime.round).toBe(2);
    expect(snapshot.context.runtime.workspace.endsWith("/")).toBe(true);
  });

  test("updates the same context system message across turns", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.prepareUserTurn("hello");
    session.prepareUserTurn("again");

    const messages = session.getMessagesSnapshot();
    const systemMessageCount = messages.filter((item) => item.role === "system").length;

    expect(systemMessageCount).toBe(2);
    expect(messages.at(-1)?.content).toBe("again");
    expect(session.getContextSnapshot().runtime.round).toBe(3);
  });

  test("prepareInternalContinuationTurn injects context without advancing round by default", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.prepareUserTurn("hello");
    const afterUserTurn = session.getContextSnapshot();

    session.prepareInternalContinuationTurn("continue");

    const snapshot = session.snapshot();
    expect(snapshot.messages.at(-1)?.content).toBe("continue");
    expect(snapshot.context.runtime.round).toBe(afterUserTurn.runtime.round);
    expect(snapshot.context.runtime.datetime).not.toBe(afterUserTurn.runtime.datetime);
  });

  test("merges extracted context into runtime context", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.mergeExtractedContext({
      project: {
        name: "atom",
      },
    });

    const context = session.getContextSnapshot() as {
      project?: { name?: string };
    };
    expect(context.project?.name).toBe("atom");
  });

  test("sanitizes extracted memory context, ignores system field overrides, and merges by id", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.mergeExtractedContext({
      version: 999 as any,
      runtime: {
        round: 999,
        workspace: "/tmp/hijack",
        datetime: "nope",
        startup_at: 1,
      } as any,
      memory: {
        working: [
          {
            id: "task-1",
            type: "task",
            decay: 0.4,
            confidence: 0.8,
            round: 1,
            tags: ["task"],
            content: "first",
          },
          {
            id: "task-2",
            type: "task",
            decay: 0.95,
            confidence: 0.95,
            round: 1,
            tags: ["drop"],
            content: "too-decayed",
          },
        ],
      } as any,
    });

    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "task-1",
            type: "task",
            decay: 0.3,
            confidence: 0.95,
            round: 2,
            tags: ["task", "updated"],
            content: "second",
          },
        ],
      } as any,
    });

    const context = session.getContextSnapshot();
    expect(context.version).toBe(CONTEXT_POLICY.version);
    expect(context.runtime.round).toBe(1);
    expect(context.runtime.workspace).toBe("/tmp/workspace/");
    expect(context.memory.working).toHaveLength(1);
    expect(context.memory.working[0]?.id).toBe("task-1");
    expect(context.memory.working[0]?.content).toBe("second");
    expect(context.memory.working[0]?.round).toBe(1);
  });

  test("beginTaskContext writes active task and clears working/ephemeral while preserving core", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.mergeExtractedContext({
      memory: {
        core: [
          {
            id: "core-1",
            type: "identity",
            decay: 0.1,
            confidence: 0.95,
            round: 1,
            tags: ["core"],
            content: "core memory",
          },
        ],
        working: [
          {
            id: "work-1",
            type: "task",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["task"],
            content: "old working",
          },
        ],
        ephemeral: [
          {
            id: "temp-1",
            type: "hint",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["temp"],
            content: "old temp",
          },
        ],
      } as any,
    });

    session.beginTaskContext({
      id: "task-123",
      type: "http.input",
      input: "new task",
      retries: 1,
      startedAt: 1700000001234,
    });

    const context = session.getContextSnapshot() as {
      active_task?: string | null;
      active_task_meta?: Record<string, unknown> | null;
      memory: {
        core: Array<{ id: string }>;
        working: unknown[];
        ephemeral: unknown[];
      };
    };

    expect(context.active_task).toBe("new task");
    expect(context.active_task_meta).toEqual({
      id: "task-123",
      type: "http.input",
      status: "running",
      retries: 1,
      attempt: 2,
      started_at: 1700000001234,
    });
    expect(context.memory.core.map((item) => item.id)).toEqual(["core-1"]);
    expect(context.memory.working).toEqual([]);
    expect(context.memory.ephemeral).toEqual([]);
  });

  test("runtime budget updates under active_task_meta do not clear working memory", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.beginTaskContext({
      id: "task-1",
      type: "http.input",
      input: "long task",
      retries: 0,
      startedAt: 1700000001000,
    });

    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "progress-1",
            type: "task.progress",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["progress"],
            content: "done step 1",
          },
        ],
      } as any,
    });

    session.mergeExtractedContext({
      active_task_meta: {
        execution: {
          segment_index: 2,
          tool_calls: { limit: 40, used: 3, remaining: 37 },
        },
      },
    } as any);

    const context = session.getContextSnapshot() as {
      active_task_meta?: Record<string, unknown>;
      memory: { working: Array<{ id: string }> };
    };

    expect(context.memory.working.map((item) => item.id)).toEqual(["progress-1"]);
    expect((context.active_task_meta?.execution as any)?.segment_index).toBe(2);
    expect((context.active_task_meta?.execution as any)?.tool_calls?.remaining).toBe(37);
  });

  test("finishTaskContext clears active task state and records last_task metadata", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.beginTaskContext({
      id: "task-123",
      type: "http.input",
      input: "new task",
      retries: 0,
      startedAt: 1700000001000,
    });

    session.finishTaskContext({
      id: "task-123",
      type: "http.input",
      status: "success",
      finishedAt: 1700000002000,
      retries: 1,
      attempts: 2,
    });

    const context = session.getContextSnapshot() as {
      active_task?: string | null;
      active_task_meta?: unknown;
      last_task?: Record<string, unknown>;
      memory: {
        working: unknown[];
        ephemeral: unknown[];
      };
    };

    expect(context.active_task).toBeNull();
    expect(context.active_task_meta).toBeNull();
    expect(context.last_task).toEqual({
      id: "task-123",
      type: "http.input",
      status: "success",
      finished_at: 1700000002000,
      retries: 1,
      attempts: 2,
    });
    expect(context.memory.working).toEqual([]);
    expect(context.memory.ephemeral).toEqual([]);
  });

  test("finishTaskContext can clear retry attempt context without updating last_task", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.beginTaskContext({
      id: "task-123",
      type: "http.input",
      input: "new task",
      retries: 0,
      startedAt: 1700000001000,
    });
    session.finishTaskContext(
      {
        id: "task-123",
        type: "http.input",
        status: "failed",
        finishedAt: 1700000001500,
        retries: 1,
        attempts: 1,
      },
      { recordLastTask: false },
    );
    session.beginTaskContext({
      id: "task-123",
      type: "http.input",
      input: "retry task",
      retries: 1,
      startedAt: 1700000001600,
    });

    const context = session.getContextSnapshot() as {
      active_task?: string | null;
      last_task?: unknown;
      memory: {
        working: unknown[];
        ephemeral: unknown[];
      };
    };

    expect(context.active_task).toBe("retry task");
    expect("last_task" in context).toBe(false);
    expect(context.memory.working).toEqual([]);
    expect(context.memory.ephemeral).toEqual([]);
  });

  test("preserves working memory as task_checkpoint on retry cleanup and restores it on next attempt", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.beginTaskContext({
      id: "task-long",
      type: "http.input",
      input: "long task",
      retries: 0,
      startedAt: 1700000001000,
    });
    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "progress-1",
            type: "task.progress",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["progress"],
            content: "step 1 done",
          },
        ],
      } as any,
    });

    session.finishTaskContext(
      {
        id: "task-long",
        type: "http.input",
        status: "failed",
        finishedAt: 1700000001500,
        retries: 1,
        attempts: 1,
      },
      { recordLastTask: false, preserveCheckpoint: true },
    );

    const afterRetryCleanup = session.getContextSnapshot() as {
      task_checkpoint?: Record<string, unknown> | null;
      memory: {
        working: Array<{ id: string }>;
        ephemeral: unknown[];
      };
    };

    expect(afterRetryCleanup.memory.working).toEqual([]);
    expect(afterRetryCleanup.memory.ephemeral).toEqual([]);
    expect(afterRetryCleanup.task_checkpoint).toBeTruthy();
    expect(afterRetryCleanup.task_checkpoint?.task_id).toBe("task-long");

    session.beginTaskContext({
      id: "task-long",
      type: "http.input",
      input: "long task",
      retries: 1,
      startedAt: 1700000001600,
    });

    const afterRetryBegin = session.getContextSnapshot() as {
      active_task?: string | null;
      task_checkpoint?: Record<string, unknown> | null;
      memory: {
        working: Array<{ id: string; content?: string }>;
      };
    };

    expect(afterRetryBegin.active_task).toBe("long task");
    expect(afterRetryBegin.memory.working.map((item) => item.id)).toEqual(["progress-1"]);
    expect(afterRetryBegin.memory.working[0]?.content).toBe("step 1 done");
    expect(afterRetryBegin.task_checkpoint?.task_id).toBe("task-long");
  });

  test("terminal finish clears task_checkpoint", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.beginTaskContext({
      id: "task-long",
      type: "http.input",
      input: "long task",
      retries: 0,
      startedAt: 1700000001000,
    });
    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "progress-1",
            type: "task.progress",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["progress"],
            content: "step 1 done",
          },
        ],
      } as any,
    });
    session.finishTaskContext(
      {
        id: "task-long",
        type: "http.input",
        status: "failed",
        finishedAt: 1700000001500,
        retries: 1,
        attempts: 1,
      },
      { recordLastTask: false, preserveCheckpoint: true },
    );
    session.finishTaskContext({
      id: "task-long",
      type: "http.input",
      status: "success",
      finishedAt: 1700000002000,
      retries: 1,
      attempts: 2,
    });

    const context = session.getContextSnapshot() as {
      task_checkpoint?: unknown;
      last_task?: Record<string, unknown>;
      memory: { working: unknown[]; ephemeral: unknown[] };
    };

    expect(context.task_checkpoint).toBeNull();
    expect(context.last_task?.status).toBe("success");
    expect(context.memory.working).toEqual([]);
    expect(context.memory.ephemeral).toEqual([]);
  });
});
