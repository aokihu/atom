/**
 * 提取 Context 消息的中间件
 * @author aokihu <aokihu@gmail.com>
 * @license BSD-3-Clause
 * @version 1.0
 */

import {
  type LanguageModelV3Middleware,
  type LanguageModelV3Content,
  type LanguageModelV3Text,
} from "@ai-sdk/provider";

const CONTEXT_DIVIDE_TAG = "<<<CONTEXT>>>";

function extractContext(rawText: string) {
  const divide_start = rawText.indexOf(CONTEXT_DIVIDE_TAG);

  let cleanedText = rawText;

  if (divide_start >= 0) {
    const contextRawText = rawText.slice(
      divide_start + CONTEXT_DIVIDE_TAG.length,
    );
    try {
      const context = JSON.parse(contextRawText);
      cleanedText = cleanedText.slice(0, divide_start).trimEnd().trimStart();
      return { context, cleanedText };
    } catch {
      throw new Error("Invaild JSON string!");
    }
  }

  return { context: {}, cleanedText };
}

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
    // 流式文本输出
  };
};
