/**
 * 提取 Context 消息的中间件
 * @author aokihu <aokihu@gmail.com>
 * @license BSD-3-Clause
 * @version 1.0
 */

import {
  type LanguageModelV3Middleware,
  type LanguageModelV3Content,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

const CONTEXT_DIVIDE_TAG = "<<<CONTEXT>>>";

export function extractContext(rawText: string) {
  const divide_start = rawText.indexOf(CONTEXT_DIVIDE_TAG);

  let cleanedText = rawText;

  if (divide_start >= 0) {
    const contextRawText = rawText.slice(
      divide_start + CONTEXT_DIVIDE_TAG.length,
    );
    try {
      const context: unknown = JSON.parse(contextRawText);
      cleanedText = cleanedText.slice(0, divide_start).trimEnd().trimStart();
      return { context, cleanedText };
    } catch {
      throw new Error("Invaild JSON string!");
    }
  }

  return { context: {}, cleanedText };
}

export const __extractContextMiddlewareInternals = {
  extractContext,
};

/**
 * 生成提取上下文的中间件方法
 * @returns {}
 */
export const extractContextMiddleware: (
  onExtractContext: (context: any) => void,
) => LanguageModelV3Middleware = (onExtractContext) => {
  return {
    specificationVersion: "v3",
    // 静态文本生成
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      const { content } = result;

      // 遍历content中的所有数据
      content.forEach((item: LanguageModelV3Content) => {
        const { type } = item;

        if (type === "text") {
          const { context, cleanedText } = extractContext(item.text);
          onExtractContext(context); // 当发现并且提取context的时候触发外部的相应函数
          item.text = cleanedText;
        }
      });

      return result;
    },
    // 流式文本生成
    wrapStream: async ({ doStream }) => {
      const result = await doStream();

      const tagLength = CONTEXT_DIVIDE_TAG.length;
      let textBuffer = "";
      let contextBuffer = "";
      let foundContextTag = false;
      let lastTextDeltaChunk: Extract<LanguageModelV3StreamPart, { type: "text-delta" }> | undefined;

      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(chunk, controller) {
            if (chunk.type !== "text-delta") {
              controller.enqueue(chunk);
              return;
            }

            lastTextDeltaChunk = chunk;

            if (foundContextTag) {
              contextBuffer += chunk.delta;
              return;
            }

            textBuffer += chunk.delta;
            const divideStart = textBuffer.indexOf(CONTEXT_DIVIDE_TAG);

            if (divideStart >= 0) {
              const plainText = textBuffer.slice(0, divideStart);
              const contextRaw = textBuffer.slice(divideStart + tagLength);

              if (plainText) {
                controller.enqueue({ ...chunk, delta: plainText });
              }

              foundContextTag = true;
              contextBuffer += contextRaw;
              textBuffer = "";
              return;
            }

            // 保留尾部字符，避免分片导致无法匹配分隔标记
            const minTailLength = tagLength - 1;
            if (textBuffer.length > minTailLength) {
              const outputText = textBuffer.slice(0, -minTailLength);
              textBuffer = textBuffer.slice(-minTailLength);
              controller.enqueue({ ...chunk, delta: outputText });
            }
          },
          flush(controller) {
            if (!foundContextTag && textBuffer && lastTextDeltaChunk) {
              controller.enqueue({ ...lastTextDeltaChunk, delta: textBuffer });
            }

            if (foundContextTag) {
              const { context } = extractContext(
                `${CONTEXT_DIVIDE_TAG}${contextBuffer}`,
              );
              onExtractContext(context);
            }
          },
        }),
      );

      return {
        ...result,
        stream,
      };
    },
  };
};
