import readline from "node:readline";
import { inspect } from "node:util";

import { sleep } from "bun";

import type { GatewayClient } from "../libs/channel/channel";
import { TaskStatus } from "../types/task";

// readline 是一个客户端实现，只通过 GatewayClient 与服务端通信，
// 不直接依赖 Agent 或 TaskQueue，便于后续替换为 Web/TUI 等客户端。

type StartReadlineClientOptions = {
  client: GatewayClient;
  prompt?: string;
  pollIntervalMs?: number;
};

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const printObject = (value: unknown) => {
  console.log(
    inspect(value, {
      depth: null,
      colors: Boolean(process.stdout.isTTY),
      compact: false,
    }),
  );
};

export const startReadlineClient = async (
  options: StartReadlineClientOptions,
): Promise<void> => {
  const { client, prompt = "> ", pollIntervalMs = 500 } = options;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    rl.close();
  };

  rl.on("SIGINT", () => {
    close();
  });

  const ask = () => {
    if (closed) return;

    rl.question(prompt, (input) => {
      void handleInput(input);
    });
  };

  const handleInput = async (input: string) => {
    const command = input.trim();

    if (command === "exit") {
      close();
      return;
    }

    if (!command) {
      ask();
      return;
    }

    if (command === "messages") {
      try {
        const data = await client.getAgentMessages();
        printObject(data.messages);
      } catch (error) {
        console.error("Error:", formatErrorMessage(error));
      }

      ask();
      return;
    }

    if (command === "context") {
      try {
        const data = await client.getAgentContext();
        printObject(data.context);
      } catch (error) {
        console.error("Error:", formatErrorMessage(error));
      }

      ask();
      return;
    }

    try {
      const created = await client.createTask({
        type: "readline.input",
        input: command,
      });

      const taskId = created.taskId;

      while (true) {
        const status = await client.getTask(taskId);
        const task = status.task;

        if (task.status === TaskStatus.Pending || task.status === TaskStatus.Running) {
          await sleep(pollIntervalMs);
          continue;
        }

        if (task.status === TaskStatus.Success && task.result !== undefined) {
          console.log("Answer:", task.result);
        } else if (task.status === TaskStatus.Failed) {
          console.error("Error:", task.error?.message ?? "Unknown error");
        } else if (task.status === TaskStatus.Cancelled) {
          console.log("Task was cancelled");
        } else {
          console.log("Task completed with unexpected status:", task.status);
        }

        break;
      }
    } catch (error) {
      console.error("Error:", formatErrorMessage(error));
    }

    ask();
  };

  await new Promise<void>((resolve) => {
    rl.once("close", () => {
      closed = true;
      resolve();
    });

    ask();
  });
};
