import { describe, expect, test } from "bun:test";
import { AgentSession } from "./agent_session";

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
});

