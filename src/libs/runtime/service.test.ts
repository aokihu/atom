import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";

import { AgentRuntimeService } from "./service";
import { TaskStatus } from "../../types/task";
import type { TaskOutputMessageDraft } from "../../types/http";
import type { Agent } from "../agent/agent";

const CONTEXT_OVERFLOW_ERROR =
  "This model's maximum context length is 131072 tokens. However, you requested 216143 tokens. Please reduce the length of the messages or completion.";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitUntil = async (check: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timeout");
    }
    await Bun.sleep(1);
  }
};

describe("AgentRuntimeService", () => {
  test("clears pending queue and suppresses retry when context length overflow happens", async () => {
    const firstTaskGate = createDeferred();
    let runCount = 0;

    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTask(
        _input: string,
        options?: {
          onOutputMessage?: (message: TaskOutputMessageDraft) => void;
        },
      ) {
        runCount += 1;

        if (runCount === 1) {
          await firstTaskGate.promise;
          options?.onOutputMessage?.({
            category: "other",
            type: "task.error",
            text: CONTEXT_OVERFLOW_ERROR,
          });
          throw new Error(CONTEXT_OVERFLOW_ERROR);
        }

        return "ok";
      },
      abortCurrentRun() {
        return false;
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
          },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();

    const first = service.submitTask({ input: "task-1" });
    const second = service.submitTask({ input: "task-2" });
    const third = service.submitTask({ input: "task-3" });

    await tick();
    firstTaskGate.resolve();

    for (let i = 0; i < 200; i += 1) {
      const snapshot = service.getTask(first.taskId);
      if (snapshot?.task.status === TaskStatus.Failed) {
        break;
      }
      await tick();
    }

    const firstSnapshot = service.getTask(first.taskId);
    const secondSnapshot = service.getTask(second.taskId);
    const thirdSnapshot = service.getTask(third.taskId);

    expect(firstSnapshot?.task.status).toBe(TaskStatus.Failed);
    expect(firstSnapshot?.task.retries).toBe(firstSnapshot?.task.maxRetries);
    expect(firstSnapshot?.task.error?.message).toBe(CONTEXT_OVERFLOW_ERROR);
    expect(
      firstSnapshot?.messages?.items.some(
        (item) => item.type === "task.error" && item.text === CONTEXT_OVERFLOW_ERROR,
      ),
    ).toBe(true);

    expect(secondSnapshot?.task.status).toBe(TaskStatus.Cancelled);
    expect(secondSnapshot?.task.metadata?.cancelReason).toBe("contextoverflow");
    expect(secondSnapshot?.messages?.items.some((item) => item.type === "task.status")).toBe(true);

    expect(thirdSnapshot?.task.status).toBe(TaskStatus.Cancelled);
    expect(thirdSnapshot?.task.metadata?.cancelReason).toBe("contextoverflow");

    expect(service.getQueueStats().size).toBe(0);
    expect(runCount).toBe(1);
  });

  test("cleans task context on retry and terminal completion via agent lifecycle methods", async () => {
    const beginCalls: any[] = [];
    const finishCalls: Array<{ task: any; options?: any }> = [];
    let runAttempts = 0;

    const fakeAgent = {
      beginTaskContext(task: any) {
        beginCalls.push(task);
      },
      finishTaskContext(task: any, options?: any) {
        finishCalls.push({ task, options });
      },
      async runTask() {
        runAttempts += 1;
        if (runAttempts === 1) {
          throw new Error("temporary failure");
        }
        return "ok";
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
          },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
      abortCurrentRun() {
        return false;
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "do thing" });

    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Success);
    service.stop();

    expect(beginCalls).toHaveLength(2);
    expect(beginCalls.map((call) => call.retries)).toEqual([0, 1]);
    expect(beginCalls.map((call) => call.input)).toEqual(["do thing", "do thing"]);

    expect(finishCalls).toHaveLength(2);
    expect(finishCalls[0]?.options).toEqual({ recordLastTask: false, preserveCheckpoint: true });
    expect(finishCalls[0]?.task.status).toBe("failed");
    expect(finishCalls[1]?.task.status).toBe("success");
    expect(finishCalls[1]?.options).toBeUndefined();
  });

  test("writes terminal cancelled context when agent run is aborted", async () => {
    const finishCalls: Array<{ task: any; options?: any }> = [];

    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext(task: any, options?: any) {
        finishCalls.push({ task, options });
      },
      async runTask() {
        throw new Error("request aborted");
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
          },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
      abortCurrentRun() {
        return false;
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "cancel me" });

    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Cancelled);
    service.stop();

    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.task.status).toBe("cancelled");
    expect(finishCalls[0]?.options).toBeUndefined();
  });

  test("marks controlled incomplete result as failed without queue retry and stores execution metadata", async () => {
    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTaskDetailed(
        _input: string,
        options?: {
          onOutputMessage?: (message: TaskOutputMessageDraft) => void;
        },
      ) {
        options?.onOutputMessage?.({
          category: "other",
          type: "task.finish",
          text: "Task stopped (tool_budget_exhausted)",
          finishReason: "tool_budget_exhausted",
        });
        return {
          text: "",
          finishReason: "tool_budget_exhausted",
          stepCount: 10,
          totalModelSteps: 25,
          totalToolCalls: 40,
          segmentCount: 3,
          completed: false,
          stopReason: "tool_budget_exhausted",
        };
      },
      async runTask() {
        return "should-not-be-called";
      },
      abortCurrentRun() {
        return false;
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: {
            core: [],
            working: [],
            ephemeral: [],
          },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "long task" });

    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Failed);
    service.stop();

    const snapshot = service.getTask(taskId);
    expect(snapshot?.task.status).toBe(TaskStatus.Failed);
    expect(snapshot?.task.retries).toBe(0);
    expect((snapshot?.task.metadata as any)?.execution?.stopReason).toBe("tool_budget_exhausted");
    expect((snapshot?.task.metadata as any)?.execution?.retrySuppressed).toBe(true);
    expect(
      snapshot?.messages?.items.some(
        (item) =>
          item.type === "task.status" &&
          /Task not completed: stopped by tool_budget_exhausted/.test(item.text),
      ),
    ).toBe(true);
  });

  test("returns raw and injected context views for debugging when agent exposes projection snapshot", () => {
    const rawContext = {
      version: 2.3,
      runtime: {
        round: 2,
        workspace: "/tmp/",
        datetime: new Date().toISOString(),
        startup_at: Date.now(),
      },
      memory: {
        core: [],
        working: [{ id: "w1" }],
        ephemeral: [],
      },
    } as any;

    const injectedContext = {
      ...rawContext,
      memory: {
        ...rawContext.memory,
        working: [],
      },
    };

    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTask() {
        return "ok";
      },
      abortCurrentRun() {
        return false;
      },
      getContextSnapshot() {
        return rawContext;
      },
      getContextProjectionSnapshot() {
        return {
          context: rawContext,
          injectedContext,
          projectionDebug: {
            round: 2,
            rawCounts: { core: 0, working: 1, ephemeral: 0 },
            injectedCounts: { core: 0, working: 0, ephemeral: 0 },
            droppedByReason: {
              working_status_terminal: 1,
              threshold_decay: 0,
              threshold_confidence: 0,
              expired_by_round: 0,
              over_max_items: 0,
              invalid_block: 0,
            },
            droppedSamples: {},
          },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    const response = service.getAgentContext();

    expect(response.context.memory.working).toHaveLength(1);
    expect(response.injectedContext.memory.working).toHaveLength(0);
    expect(response.projectionDebug.droppedByReason.working_status_terminal).toBe(1);
  });

  test("infers step for tool messages from step.finish events", async () => {
    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTaskDetailed(
        _input: string,
        options?: {
          onOutputMessage?: (message: TaskOutputMessageDraft) => void;
        },
      ) {
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.call",
          toolName: "ls",
          inputSummary: "{}",
        });
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.result",
          toolName: "ls",
          ok: true,
          outputSummary: "{}",
        });
        options?.onOutputMessage?.({
          category: "other",
          type: "step.finish",
          step: 1,
          finishReason: "stop",
          text: "Step 1 finished",
        });
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.call",
          toolName: "read",
          inputSummary: "{}",
        });
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.result",
          toolName: "read",
          ok: true,
          outputSummary: "{}",
        });
        options?.onOutputMessage?.({
          category: "other",
          type: "step.finish",
          step: 2,
          finishReason: "stop",
          text: "Step 2 finished",
        });

        return {
          text: "done",
          finishReason: "stop",
          stepCount: 2,
          totalModelSteps: 2,
          totalToolCalls: 2,
          segmentCount: 1,
          completed: true,
          stopReason: "completed",
        };
      },
      async runTask() {
        return "should-not-be-called";
      },
      abortCurrentRun() {
        return false;
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: { core: [], working: [], ephemeral: [] },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "step inference" });

    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Success);
    service.stop();

    const toolMessages = service.getTask(taskId)?.messages?.items.filter(
      (item) => item.category === "tool",
    );

    expect(toolMessages?.map((item) => item.step)).toEqual([1, 1, 2, 2]);
  });

  test("keeps inferred tool steps monotonic across segment step resets", async () => {
    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTaskDetailed(
        _input: string,
        options?: {
          onOutputMessage?: (message: TaskOutputMessageDraft) => void;
        },
      ) {
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.call",
          toolName: "ls",
        });
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.result",
          toolName: "ls",
          ok: true,
        });
        options?.onOutputMessage?.({
          category: "other",
          type: "step.finish",
          step: 1,
          finishReason: "length",
          text: "Step 1 finished",
        });
        options?.onOutputMessage?.({
          category: "other",
          type: "task.finish",
          finishReason: "step_limit_segment_continue",
          text: "segment continue",
        });

        // Simulate next segment starting and step numbers resetting to 1.
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.call",
          toolName: "read",
        });
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.result",
          toolName: "read",
          ok: true,
        });
        options?.onOutputMessage?.({
          category: "other",
          type: "step.finish",
          step: 1,
          finishReason: "stop",
          text: "Step 1 finished (segment 2)",
        });

        return {
          text: "done",
          finishReason: "stop",
          stepCount: 1,
          totalModelSteps: 2,
          totalToolCalls: 2,
          segmentCount: 2,
          completed: true,
          stopReason: "completed",
        };
      },
      async runTask() {
        return "should-not-be-called";
      },
      abortCurrentRun() {
        return false;
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: { core: [], working: [], ephemeral: [] },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "segment reset" });

    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Success);
    service.stop();

    const toolMessages = service.getTask(taskId)?.messages?.items.filter(
      (item) => item.category === "tool",
    );

    expect(toolMessages?.map((item) => `${item.toolName}:${item.step}`)).toEqual([
      "ls:1",
      "ls:1",
      "read:2",
      "read:2",
    ]);
  });

  test("preserves explicit tool message steps without rewriting them", async () => {
    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTaskDetailed(
        _input: string,
        options?: {
          onOutputMessage?: (message: TaskOutputMessageDraft) => void;
        },
      ) {
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.call",
          toolName: "ls",
          toolCallId: "call-1",
          step: 7,
        });
        options?.onOutputMessage?.({
          category: "tool",
          type: "tool.result",
          toolName: "ls",
          toolCallId: "call-1",
          ok: true,
          step: 7,
        });
        options?.onOutputMessage?.({
          category: "other",
          type: "step.finish",
          step: 1,
          finishReason: "stop",
          text: "Step 1 finished",
        });

        return {
          text: "done",
          finishReason: "stop",
          stepCount: 1,
          totalModelSteps: 1,
          totalToolCalls: 1,
          segmentCount: 1,
          completed: true,
          stopReason: "completed",
        };
      },
      async runTask() {
        return "should-not-be-called";
      },
      abortCurrentRun() {
        return false;
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: { core: [], working: [], ephemeral: [] },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "explicit step passthrough" });

    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Success);
    service.stop();

    const toolMessages = service.getTask(taskId)?.messages?.items.filter(
      (item) => item.category === "tool",
    );

    expect(toolMessages?.map((item) => item.step)).toEqual([7, 7]);
  });

  test("updateSystemPrompt syncs messages when runtime is idle", () => {
    const updates: Array<{ prompt: string; options?: { syncMessages?: boolean } }> = [];
    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTask() {
        return "ok";
      },
      abortCurrentRun() {
        return false;
      },
      updateSystemPrompt(prompt: string, options?: { syncMessages?: boolean }) {
        updates.push({ prompt, options });
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: { core: [], working: [], ephemeral: [] },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    service.updateSystemPrompt("new prompt");
    service.stop();

    expect(updates).toEqual([{ prompt: "new prompt", options: { syncMessages: true } }]);
  });

  test("updateSystemPrompt does not sync messages while task is running", async () => {
    const updates: Array<{ prompt: string; options?: { syncMessages?: boolean } }> = [];
    const gate = createDeferred();
    const fakeAgent = {
      beginTaskContext() {},
      finishTaskContext() {},
      async runTask() {
        await gate.promise;
        return "ok";
      },
      abortCurrentRun() {
        return false;
      },
      updateSystemPrompt(prompt: string, options?: { syncMessages?: boolean }) {
        updates.push({ prompt, options });
      },
      getContextSnapshot() {
        return {
          version: 2.3,
          runtime: {
            round: 1,
            workspace: "/tmp/",
            datetime: new Date().toISOString(),
            startup_at: Date.now(),
          },
          memory: { core: [], working: [], ephemeral: [] },
        };
      },
      getMessagesSnapshot() {
        return [] as ModelMessage[];
      },
    } as unknown as Agent;

    const service = new AgentRuntimeService(fakeAgent, { log() {} });
    service.start();
    const { taskId } = service.submitTask({ input: "long running task" });
    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Running);

    service.updateSystemPrompt("new prompt");
    gate.resolve();
    await waitUntil(() => service.getTask(taskId)?.task.status === TaskStatus.Success);
    service.stop();

    expect(updates).toEqual([{ prompt: "new prompt", options: { syncMessages: false } }]);
  });
});
