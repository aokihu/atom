import { describe, expect, test } from "bun:test";
import {
  extractContext,
  extractContextMiddleware,
} from "./extractContextMiddleware";

describe("extractContextMiddleware", () => {
  test("extractContext parses context payload and strips tag suffix", () => {
    const result = extractContext('hello\n<<<CONTEXT>>>{"a":1}');
    expect(result.cleanedText).toBe("hello");
    expect(result.context).toEqual({ a: 1 });
  });

  test("stream mode handles split context tag across chunks", async () => {
    let extracted: unknown;
    const middleware = extractContextMiddleware((context) => {
      extracted = context;
    });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "hello <<<CO" });
        controller.enqueue({ type: "text-delta", delta: 'NTEXT>>>{"x":1}' });
        controller.close();
      },
    });

    const wrapped = await middleware.wrapStream?.({
      doStream: async () => ({ stream }),
    } as any);

    const reader = wrapped!.stream.getReader();
    const deltas: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") {
        deltas.push(value.delta);
      }
    }

    expect(deltas.join("")).toBe("hello ");
    expect(extracted).toEqual({ x: 1 });
  });
});

