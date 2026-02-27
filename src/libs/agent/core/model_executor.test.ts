import { describe, expect, test } from "bun:test";

import type { TaskOutputMessageDraft } from "../../../types/http";
import { AISDKModelExecutor, type ModelExecutionInput } from "./model_executor";

const makeBaseInput = (
  messages: TaskOutputMessageDraft[],
  patch: Partial<ModelExecutionInput> = {},
): ModelExecutionInput => ({
  model: {} as any,
  messages: [],
  tools: {} as any,
  stopWhen: {} as any,
  onOutputMessage: (message) => {
    messages.push(message);
  },
  ...patch,
});

describe("AISDKModelExecutor", () => {
  test("generate emits tool call/result from experimental tool hooks with 1-based step", async () => {
    const messages: TaskOutputMessageDraft[] = [];

    const executor = new AISDKModelExecutor({
      generateTextFn: (async (options: any) => {
        await options.experimental_onToolCallStart?.({
          stepNumber: 0,
          toolCall: {
            toolCallId: "call-1",
            toolName: "ls",
            input: { dirpath: "/tmp/demo", long: true },
          },
        });
        await options.experimental_onToolCallFinish?.({
          stepNumber: 0,
          toolCall: {
            toolCallId: "call-1",
            toolName: "ls",
            input: { dirpath: "/tmp/demo", long: true },
          },
          success: true,
          output: {
            dirpath: "/tmp/demo",
            output: "a\nb\n",
          },
          durationMs: 5,
        });
        await options.onStepFinish?.({ finishReason: "stop" });
        return {
          text: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }) as any,
    });

    const result = await executor.generate(makeBaseInput(messages));

    expect(result.text).toBe("done");
    expect(result.stepCount).toBe(1);

    const toolCall = messages.find((m) => m.category === "tool" && m.type === "tool.call");
    const toolResult = messages.find((m) => m.category === "tool" && m.type === "tool.result");
    const stepFinish = messages.find((m) => m.category === "other" && m.type === "step.finish");

    expect(toolCall).toBeDefined();
    expect(toolCall && "step" in toolCall ? toolCall.step : undefined).toBe(1);
    expect(toolCall && "toolCallId" in toolCall ? toolCall.toolCallId : undefined).toBe("call-1");
    expect(toolCall && "inputDisplay" in toolCall ? toolCall.inputDisplay?.templateKey : undefined)
      .toBe("builtin.ls.call");

    expect(toolResult).toBeDefined();
    expect(toolResult && "step" in toolResult ? toolResult.step : undefined).toBe(1);
    expect(toolResult && "ok" in toolResult ? toolResult.ok : undefined).toBe(true);
    expect(toolResult && "outputDisplay" in toolResult ? toolResult.outputDisplay?.templateKey : undefined)
      .toBe("builtin.ls.result");

    expect(stepFinish && "step" in stepFinish ? stepFinish.step : undefined).toBe(1);
  });

  test("generate marks semantic tool output errors as failed results", async () => {
    const messages: TaskOutputMessageDraft[] = [];

    const executor = new AISDKModelExecutor({
      generateTextFn: (async (options: any) => {
        await options.experimental_onToolCallStart?.({
          stepNumber: 1,
          toolCall: {
            toolCallId: "call-2",
            toolName: "read",
            input: { filepath: "/tmp/a.txt" },
          },
        });
        await options.experimental_onToolCallFinish?.({
          stepNumber: 1,
          toolCall: {
            toolCallId: "call-2",
            toolName: "read",
            input: { filepath: "/tmp/a.txt" },
          },
          success: true,
          output: { error: "permission denied" },
          durationMs: 3,
        });
        await options.onStepFinish?.({ finishReason: "stop" });
        return { text: "done", finishReason: "stop" };
      }) as any,
    });

    await executor.generate(makeBaseInput(messages));

    const toolResult = messages.find(
      (m) => m.category === "tool" && m.type === "tool.result" && m.toolCallId === "call-2",
    );

    expect(toolResult && "ok" in toolResult ? toolResult.ok : undefined).toBe(false);
    expect(toolResult && "errorMessage" in toolResult ? toolResult.errorMessage : undefined)
      .toBe("permission denied");
  });

  test("generate marks MCP isError tool output as failed results", async () => {
    const messages: TaskOutputMessageDraft[] = [];

    const executor = new AISDKModelExecutor({
      generateTextFn: (async (options: any) => {
        await options.experimental_onToolCallStart?.({
          stepNumber: 1,
          toolCall: {
            toolCallId: "call-mcp-1",
            toolName: "browser__navigate",
            input: { url: "https://example.com" },
          },
        });
        await options.experimental_onToolCallFinish?.({
          stepNumber: 1,
          toolCall: {
            toolCallId: "call-mcp-1",
            toolName: "browser__navigate",
            input: { url: "https://example.com" },
          },
          success: true,
          output: {
            isError: true,
            content: [{ type: "text", text: "blocked by policy" }],
          },
          durationMs: 3,
        });
        await options.onStepFinish?.({ finishReason: "stop" });
        return { text: "done", finishReason: "stop" };
      }) as any,
    });

    await executor.generate(makeBaseInput(messages));

    const toolResult = messages.find(
      (m) => m.category === "tool" && m.type === "tool.result" && m.toolCallId === "call-mcp-1",
    );

    expect(toolResult && "ok" in toolResult ? toolResult.ok : undefined).toBe(false);
    expect(toolResult && "errorMessage" in toolResult ? toolResult.errorMessage : undefined)
      .toBe("blocked by policy");
  });

  test("generate maps tool hook execution errors to failed tool results", async () => {
    const messages: TaskOutputMessageDraft[] = [];

    const executor = new AISDKModelExecutor({
      generateTextFn: (async (options: any) => {
        await options.experimental_onToolCallStart?.({
          stepNumber: 0,
          toolCall: {
            toolCallId: "call-3",
            toolName: "git",
            input: { args: ["status"] },
          },
        });
        await options.experimental_onToolCallFinish?.({
          stepNumber: 0,
          toolCall: {
            toolCallId: "call-3",
            toolName: "git",
            input: { args: ["status"] },
          },
          success: false,
          error: new Error("boom"),
          durationMs: 9,
        });
        await options.onStepFinish?.({ finishReason: "stop" });
        return { text: "done", finishReason: "stop" };
      }) as any,
    });

    await executor.generate(makeBaseInput(messages));

    const toolResult = messages.find(
      (m) => m.category === "tool" && m.type === "tool.result" && m.toolCallId === "call-3",
    );

    expect(toolResult && "ok" in toolResult ? toolResult.ok : undefined).toBe(false);
    expect(toolResult && "errorMessage" in toolResult ? toolResult.errorMessage : undefined).toBe("boom");
  });

  test("stream wires experimental tool hooks and emits tool messages before step.finish", async () => {
    const messages: TaskOutputMessageDraft[] = [];

    const executor = new AISDKModelExecutor({
      streamTextFn: ((options: any) => {
        void (async () => {
          await options.experimental_onToolCallStart?.({
            stepNumber: 0,
            toolCall: {
              toolCallId: "call-s1",
              toolName: "tree",
              input: { dirpath: "/tmp/demo" },
            },
          });
          await options.experimental_onToolCallFinish?.({
            stepNumber: 0,
            toolCall: {
              toolCallId: "call-s1",
              toolName: "tree",
              input: { dirpath: "/tmp/demo" },
            },
            success: true,
            output: { dirpath: "/tmp/demo", output: "demo\n" },
            durationMs: 4,
          });
          await options.onStepFinish?.({ finishReason: "stop" });
          await options.onFinish?.({
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        })();

        return {
          textStream: (async function* () {})(),
        } as any;
      }) as any,
    });

    executor.stream(makeBaseInput(messages));

    await Bun.sleep(0);
    await Bun.sleep(0);

    const sequence = messages.map((m) => `${m.category}:${m.type}`);
    expect(sequence).toContain("tool:tool.call");
    expect(sequence).toContain("tool:tool.result");
    expect(sequence).toContain("other:step.finish");
    expect(sequence).toContain("assistant:assistant.text");
    expect(sequence).toContain("other:task.finish");

    expect(sequence.indexOf("tool:tool.result")).toBeLessThan(sequence.indexOf("other:step.finish"));
  });
});
