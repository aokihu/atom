import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_EXECUTION_CONFIG } from "../../../types/agent";
import { AgentSession } from "../session/agent_session";
import { AgentRunner, __agentRunnerInternals } from "./agent_runner";

describe("agent_runner internals", () => {
  test("classifies non-limit segment as completed", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "stop",
      segmentStepCount: 3,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerRun: 10,
      },
      totalModelSteps: 3,
      continuationRuns: 0,
    });

    expect(result).toEqual({ kind: "completed" });
  });

  test("classifies per-run step limit as auto_continue when continuation budget remains", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "length",
      segmentStepCount: 10,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerRun: 10,
        autoContinueOnStepLimit: true,
        maxContinuationRuns: 5,
      },
      totalModelSteps: 10,
      continuationRuns: 0,
    });

    expect(result).toEqual({ kind: "auto_continue" });
  });

  test("classifies continuation budget exhaustion as controlled stop", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "length",
      segmentStepCount: 10,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerRun: 10,
        autoContinueOnStepLimit: true,
        maxContinuationRuns: 1,
      },
      totalModelSteps: 20,
      continuationRuns: 1,
    });

    expect(result).toEqual({
      kind: "stop",
      stopReason: "continuation_limit_reached",
    });
  });

  test("prioritizes total model step budget exhaustion before completion classification", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "stop",
      segmentStepCount: 2,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerTask: 20,
        maxModelStepsPerRun: 10,
      },
      totalModelSteps: 20,
      continuationRuns: 0,
    });

    expect(result).toEqual({
      kind: "stop",
      stopReason: "model_step_budget_exhausted",
    });
  });

  test("extracts todo progress snapshot from tool output", () => {
    const progress = __agentRunnerInternals.getTodoProgressContextFromToolOutput({
      success: true,
      todo: {
        summary: "进行中 1/2（当前第2步）",
        total: 2,
        step: 2,
      },
    });

    expect(progress).toEqual({
      summary: "进行中 1/2（当前第2步）",
      total: 2,
      step: 2,
    });
    expect(__agentRunnerInternals.getTodoProgressContextFromToolOutput({ success: true })).toBeNull();
  });

  test("reconciles stale or consumed todo cursor without blocking", () => {
    const missing = __agentRunnerInternals.reconcileTodoCursor(
      { next: "todo_complete", targetId: 99 },
      [{ id: 1, status: "open" }],
    );
    expect(missing).toEqual({ kind: "clear", reason: "target_missing" });

    const consumedComplete = __agentRunnerInternals.reconcileTodoCursor(
      { next: "todo_complete", targetId: 1 },
      [{ id: 1, status: "done" }],
    );
    expect(consumedComplete).toEqual({ kind: "clear", reason: "consumed_complete" });

    const keep = __agentRunnerInternals.reconcileTodoCursor(
      { next: "todo_update", targetId: 1 },
      [{ id: 1, status: "open" }],
    );
    expect(keep).toEqual({ kind: "keep" });
  });
});

describe("agent_runner persistent memory hooks", () => {
  const createSession = () =>
    new AgentSession({
      workspace: "/tmp/atom-runner-test",
      systemPrompt: "system",
    });

  const createRunnerForTest = (args: {
    generateResults?: Array<{ text: string; finishReason: string; stepCount: number }>;
    streamParts?: string[];
    hooks?: {
      beforeTask?: (...args: any[]) => any;
      afterTask?: (...args: any[]) => any;
    };
    executionConfig?: Partial<typeof DEFAULT_AGENT_EXECUTION_CONFIG>;
  }) => {
    const generateResults = [...(args.generateResults ?? [{ text: "ok", finishReason: "stop", stepCount: 1 }])];
    const modelExecutor = {
      generate: async () => {
        const next = generateResults.shift();
        if (!next) {
          throw new Error("No stub generate result left");
        }
        return next;
      },
      stream: () => ({
        textStream: (async function* () {
          for (const part of args.streamParts ?? ["hello"]) {
            yield part;
          }
        })(),
      }),
    } as any;

    const runner = new AgentRunner({
      model: {} as any,
      dependencies: {
        modelExecutor,
        createToolRegistry: () => ({} as any),
        createExtractContextMiddleware: () => (({ doGenerate }: any) => doGenerate?.({}) ?? {}) as any,
        executionConfig: {
          ...DEFAULT_AGENT_EXECUTION_CONFIG,
          ...(args.executionConfig ?? {}),
        },
        persistentMemoryHooks: {
          beforeTask: async (...hookArgs: unknown[]) => {
            await args.hooks?.beforeTask?.(...hookArgs);
          },
          afterTask: async (...hookArgs: unknown[]) => {
            await args.hooks?.afterTask?.(...hookArgs);
          },
        },
      },
    });

    (runner as any).createContextAwareModel = () => ({}) as any;
    return runner;
  };

  test("calls beforeTask once across continuation segments and calls afterTask on completion", async () => {
    const calls: Array<{ phase: "before" | "after"; meta?: unknown }> = [];
    const runner = createRunnerForTest({
      generateResults: [
        { text: "partial", finishReason: "length", stepCount: 2 },
        { text: "done", finishReason: "stop", stepCount: 1 },
      ],
      executionConfig: {
        maxModelStepsPerRun: 2,
        maxContinuationRuns: 3,
        maxModelStepsPerTask: 10,
      },
      hooks: {
        beforeTask: async () => {
          calls.push({ phase: "before" });
        },
        afterTask: async (_session: AgentSession, meta: unknown) => {
          calls.push({ phase: "after", meta });
        },
      },
    });

    const result = await runner.runTaskDetailed(createSession(), "question");

    expect(result.completed).toBe(true);
    expect(calls.filter((call) => call.phase === "before")).toHaveLength(1);
    expect(calls.filter((call) => call.phase === "after")).toHaveLength(1);
    expect(calls.find((call) => call.phase === "after")?.meta).toMatchObject({
      completed: true,
      mode: "detailed",
      finishReason: "stop",
    });
  });

  test("afterTask still runs when task stops in controlled path", async () => {
    const afterCalls: unknown[] = [];
    const runner = createRunnerForTest({
      generateResults: [{ text: "partial", finishReason: "length", stepCount: 2 }],
      executionConfig: {
        maxModelStepsPerRun: 2,
        autoContinueOnStepLimit: false,
        maxModelStepsPerTask: 10,
      },
      hooks: {
        afterTask: async (_session: AgentSession, meta: unknown) => {
          afterCalls.push(meta);
        },
      },
    });

    const result = await runner.runTaskDetailed(createSession(), "question");

    expect(result.completed).toBe(false);
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]).toMatchObject({
      completed: false,
      mode: "detailed",
      stopReason: "step_limit_segment_continue",
    });
  });

  test("hook errors are fail-open and do not block task execution", async () => {
    const runner = createRunnerForTest({
      hooks: {
        beforeTask: async () => {
          throw new Error("before failed");
        },
        afterTask: async () => {
          throw new Error("after failed");
        },
      },
    });

    const result = await runner.runTaskDetailed(createSession(), "question");
    expect(result.completed).toBe(true);
    expect(result.text).toBe("ok");
  });

  test("runTaskStream calls hooks and afterTask runs when stream finishes", async () => {
    const calls: string[] = [];
    const runner = createRunnerForTest({
      streamParts: ["a", "b"],
      hooks: {
        beforeTask: async () => {
          calls.push("before");
        },
        afterTask: async () => {
          calls.push("after");
        },
      },
    });

    const stream = await runner.runTaskStream(createSession(), "question");
    const parts: string[] = [];
    for await (const part of stream.textStream as AsyncIterable<string>) {
      parts.push(part);
    }

    expect(parts).toEqual(["a", "b"]);
    expect(calls).toEqual(["before", "after"]);
  });
});
