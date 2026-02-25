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
});
