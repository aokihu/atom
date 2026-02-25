import { describe, expect, test } from "bun:test";

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

describe("AgentRuntimeService", () => {
  test("clears pending queue and suppresses retry when context length overflow happens", async () => {
    const firstTaskGate = createDeferred();
    let runCount = 0;

    const fakeAgent = {
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
        return {} as any;
      },
      getMessagesSnapshot() {
        return [];
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
    expect(firstSnapshot?.messages?.items.some((item) => item.type === "task.error" && item.text === CONTEXT_OVERFLOW_ERROR)).toBe(
      true,
    );

    expect(secondSnapshot?.task.status).toBe(TaskStatus.Cancelled);
    expect(secondSnapshot?.task.metadata?.cancelReason).toBe("contextoverflow");
    expect(secondSnapshot?.messages?.items.some((item) => item.type === "task.status")).toBe(true);

    expect(thirdSnapshot?.task.status).toBe(TaskStatus.Cancelled);
    expect(thirdSnapshot?.task.metadata?.cancelReason).toBe("contextoverflow");

    expect(service.getQueueStats().size).toBe(0);
    expect(runCount).toBe(1);
  });
});
