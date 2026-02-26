import { describe, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
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

  test("beginTaskContext resets prior task conversation messages so tasks do not chain through message history", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.beginTaskContext({
      id: "task-1",
      type: "http.input",
      input: "first task",
      retries: 0,
      startedAt: 1700000001000,
    });
    session.prepareUserTurn("old question");
    expect(session.getMessagesSnapshot().some((m) => m.role === "user" && m.content === "old question")).toBe(
      true,
    );

    session.beginTaskContext({
      id: "task-2",
      type: "http.input",
      input: "second task",
      retries: 0,
      startedAt: 1700000002000,
    });
    session.prepareUserTurn("new question");

    const messages = session.getMessagesSnapshot();
    expect(messages.some((m) => m.role === "user" && m.content === "old question")).toBe(false);
    expect(messages.some((m) => m.role === "user" && m.content === "new question")).toBe(true);
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

  test("records SDK token usage into runtime.token_usage and accumulates total tokens", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.recordRuntimeTokenUsageFromSDK({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      reasoningTokens: 8,
      cachedInputTokens: 32,
    });
    session.recordRuntimeTokenUsageFromSDK({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const context = session.getContextSnapshot();
    expect(context.runtime.token_usage).toBeTruthy();
    expect(context.runtime.token_usage).toMatchObject({
      source: "ai-sdk",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cumulative_total_tokens: 180,
    });
    expect(context.runtime.token_usage?.reasoning_tokens).toBeUndefined();
    expect(context.runtime.token_usage?.cached_input_tokens).toBeUndefined();
    expect(typeof context.runtime.token_usage?.updated_at).toBe("number");
  });

  test("hard-sanitizes extracted memory context, ignores system field overrides, and merges by id", () => {
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
    expect(context.memory.working).toHaveLength(2);
    expect(context.memory.working[0]?.id).toBe("task-1");
    expect(context.memory.working[0]?.content).toBe("second");
    expect(context.memory.working[0]?.round).toBe(1);
    expect(context.memory.working.find((item) => item.id === "task-2")?.content).toBe("too-decayed");
  });

  test("beginTaskContext writes active task, closes stale open working, and preserves raw ephemeral/core", () => {
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
    expect(context.memory.working).toHaveLength(1);
    expect((context.memory.working[0] as any)?.status).toBe("cancelled");
    expect((context.memory.working[0] as any)?.closed_at).toBe(1700000001234);
    expect(context.memory.ephemeral).toHaveLength(1);
  });

  test("finishTaskContext clears active task state, records last_task metadata, and marks working terminal", () => {
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
    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "work-1",
            type: "task",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["task"],
            content: "in progress",
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
            content: "raw temp",
          },
        ],
      } as any,
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
        working: Array<Record<string, unknown>>;
        ephemeral: Array<Record<string, unknown>>;
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
    expect(context.memory.working).toHaveLength(1);
    expect(context.memory.working[0]?.status).toBe("done");
    expect(context.memory.working[0]?.task_id).toBe("task-123");
    expect(context.memory.working[0]?.closed_at).toBe(1700000002000);
    expect(context.memory.ephemeral).toHaveLength(1);
  });

  test("finishTaskContext can end retry attempt without updating last_task and preserves failed raw working history", () => {
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
    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "work-1",
            type: "task",
            decay: 0.2,
            confidence: 0.9,
            round: 1,
            tags: ["task"],
            content: "retry progress",
          },
        ],
      } as any,
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
        working: Array<Record<string, unknown>>;
        ephemeral: unknown[];
      };
    };

    expect(context.active_task).toBe("retry task");
    expect("last_task" in context).toBe(false);
    expect(context.memory.working).toHaveLength(1);
    expect(context.memory.working[0]?.id).toBe("work-1");
    expect(context.memory.working[0]?.status).toBe("failed");
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

    expect(afterRetryCleanup.memory.working).toHaveLength(1);
    expect((afterRetryCleanup.memory.working[0] as any)?.id).toBe("progress-1");
    expect((afterRetryCleanup.memory.working[0] as any)?.status).toBe("failed");
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
    expect((afterRetryBegin.memory.working[0] as any)?.status).toBe("open");
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
      memory: { working: Array<Record<string, unknown>>; ephemeral: unknown[] };
    };

    expect(context.task_checkpoint).toBeNull();
    expect(context.last_task?.status).toBe("success");
    expect(context.memory.working).toHaveLength(1);
    expect(context.memory.working[0]?.status).toBe("failed");
    expect(context.memory.ephemeral).toEqual([]);
  });

  test("injectContext uses projected context so terminal working blocks stay in raw but are excluded from injected context", () => {
    const session = new AgentSession({
      workspace: "/tmp/workspace",
      systemPrompt: "system prompt",
      contextClock: createClock(),
    });

    session.mergeExtractedContext({
      memory: {
        working: [
          {
            id: "work-done",
            type: "task",
            decay: 0.1,
            confidence: 0.95,
            round: 1,
            tags: ["task"],
            content: "already finished",
            status: "done",
          },
          {
            id: "work-open",
            type: "task",
            decay: 0.1,
            confidence: 0.95,
            round: 1,
            tags: ["task"],
            content: "current work",
            status: "open",
          },
        ],
      } as any,
      last_task: { id: "t-1", status: "success" } as any,
      task_checkpoint: { task_id: "t-1", working_memory: [] } as any,
    });

    const projection = session.getContextProjectionSnapshot();
    expect(projection.context.memory.working.map((item) => item.id).sort()).toEqual([
      "work-done",
      "work-open",
    ]);
    expect(projection.injectedContext.memory.working.map((item) => item.id)).toEqual(["work-open"]);
    expect((projection.injectedContext as any).last_task).toBeUndefined();
    expect((projection.injectedContext as any).task_checkpoint).toBeUndefined();

    session.prepareUserTurn("next");
    const systemContextMessage = String(session.getMessagesSnapshot()[0]?.content ?? "");
    const encoded = systemContextMessage.split("\n").slice(1, -1).join("\n");
    const decoded = decode(encoded) as any;
    expect(decoded.memory.working.map((item: any) => item.id)).toEqual(["work-open"]);
    expect(decoded.last_task).toBeUndefined();
    expect(decoded.task_checkpoint).toBeUndefined();
  });
});
