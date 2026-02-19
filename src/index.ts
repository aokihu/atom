/**
 * Atom - 一个功能强大的AI Agent
 * @author aokihu <aokihu@gmail.com>
 * @version 0.0.1
 * @license BSD
 */

import { join } from "node:path";
import { bootstrap } from "./libs/agent/boot";
import { Agent } from "./libs/agent/agent";

import readline from "node:readline";

/* AI SDK */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { PriorityTaskQueue } from "./libs/runtime/queue/task_queue";
import { createTask } from "./libs/runtime/queue/factory";
import { sleep } from "bun";
import { TaskStatus, type TaskItem } from "./types/task";

const GlobalModel = createDeepSeek({
  apiKey: process.env.AI_API_KEY,
})("deepseek-chat");

// 全局
const GLOBAL_VAR_TABLE = new Map();

console.time("BootStage 1");

console.log("Bootstrap");
console.log("Compile agent prompt...");
const { systemPrompt } = await bootstrap(GlobalModel)({
  userPromptFilePath: join(process.cwd(), "Playground/AGENT.md"),
  enableOptimization: true,
});
console.timeEnd("BootStage 1");
console.timeLog("BootStage 1");

console.log("Compiled. Launching agent...");

const taskAgent = new Agent({
  systemPrompt: systemPrompt,
  model: GlobalModel,
});

console.log("Create Task Queue...");
const taskQueue = new PriorityTaskQueue(
  async (task: TaskItem<string, string>) => {
    task.status = TaskStatus.Running;
    task.startedAt = Date.now();
    console.log("Thinking...");
    const answer = await taskAgent.runTask(task.input);

    task.result = answer;
    task.status = TaskStatus.Success;
    task.finishedAt = Date.now();
  },
);
taskQueue.start();

console.log("Agent launched.");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask() {
  rl.question("> ", async (input) => {
    if (input === "exit") {
      rl.close();
      return;
    }

    if (input === "messages") {
      taskAgent.displayMessages();
      ask();
      return;
    }

    if (input === "context") {
      taskAgent.displayContext();
      ask();
      return;
    }

    const task = createTask<string, string>("rl.input", input);
    taskQueue.add(task);

    while (
      task.status === TaskStatus.Pending ||
      task.status === TaskStatus.Running
    ) {
      await sleep(1000);
    }

    console.log("Answer:", task.result!);

    ask();
  });
}

ask();
