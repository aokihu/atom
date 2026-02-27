import type { GatewayClient } from "../../../libs/channel/channel";
import type { TaskOutputMessage, TaskSnapshot } from "../../../types/http";
import { isTaskStillRunning } from "./task_flow";

type ClientOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export type ExecutePolledTaskInput = {
  client: GatewayClient;
  taskType: string;
  taskInput: string;
  pollIntervalMs: number;
  sleepFn: (ms: number) => Promise<void>;
  runClientOperation?: ClientOperationRunner;
  shouldStop?: () => boolean;
  onTaskCreated?: (taskId: string) => void;
  onTaskMessages?: (taskId: string, messages: TaskOutputMessage[]) => void;
};

export type ExecutePolledTaskResult = {
  taskId: string;
  task: TaskSnapshot;
  stopped: boolean;
};

const passthroughClientOperation: ClientOperationRunner = (operation) => operation();

const shouldNeverStop = (): boolean => false;

export const executePolledTask = async (
  input: ExecutePolledTaskInput,
): Promise<ExecutePolledTaskResult> => {
  const runClientOperation = input.runClientOperation ?? passthroughClientOperation;
  const shouldStop = input.shouldStop ?? shouldNeverStop;

  const created = await runClientOperation(() =>
    input.client.createTask({
      type: input.taskType,
      input: input.taskInput,
    }),
  );

  if (shouldStop()) {
    return {
      taskId: created.taskId,
      task: created.task,
      stopped: true,
    };
  }

  input.onTaskCreated?.(created.taskId);
  let afterSeq = 0;

  for (;;) {
    if (shouldStop()) {
      return {
        taskId: created.taskId,
        task: created.task,
        stopped: true,
      };
    }

    const status = await runClientOperation(() =>
      input.client.getTask(created.taskId, { afterSeq }),
    );
    const delta = status.messages;
    if (delta) {
      afterSeq = delta.latestSeq;
      if (delta.items.length > 0) {
        input.onTaskMessages?.(created.taskId, delta.items);
      }
    }

    if (!isTaskStillRunning(status.task.status)) {
      return {
        taskId: created.taskId,
        task: status.task,
        stopped: false,
      };
    }

    await input.sleepFn(input.pollIntervalMs);
  }
};
