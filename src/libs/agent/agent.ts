/**
 * Agent自动执行单元
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.1
 */

import { inspect } from "node:util";
import { generateText, type LanguageModel, type ModelMessage } from "ai";

const CONTEXT_OPEN_TAG = "<context>";
const CONTEXT_CLOSE_TAG = "</context>";

export class Agent {
  private rawContext: string;
  private messages: ModelMessage[];
  private model: LanguageModel | undefined;
  private systemPrompt: string | undefined;
  private abortController: AbortController | undefined;

  constructor(arg: { model: LanguageModel; systemPrompt: string }) {
    this.model = arg.model;
    this.systemPrompt = arg.systemPrompt;

    // 上下文原始文字内容
    this.rawContext = "";

    // 消息数组
    this.messages = [{ role: "system", content: this.systemPrompt }];

    // 终止控制器
    this.abortController = new AbortController();
  }

  /**
   * 执行一个任务
   */
  async runTask(question: string) {
    this.syncContextMessage();

    this.messages.push({
      role: "user",
      content: question,
    });

    const { text, response } = await generateText({
      model: this.model!,
      abortSignal: this.abortController?.signal,
      messages: this.messages,
    });

    // 清理接收到的助理消息
    // 将context内容保存到this.rawContext
    // 只将非context内容保存到历史消息中

    const lastMessage = response.messages[0];
    const cleanedText = this.processAssistantOutput(text);
    this.messages.push({
      role: "assistant",
      content: cleanedText,
      providerOptions: lastMessage?.providerOptions,
    });

    return cleanedText;
  }

  displayMessages() {
    console.log(
      inspect(this.messages, { depth: null, colors: true, compact: false }),
    );
  }

  displayContext() {
    console.log(this.rawContext);
  }

  /**
   * 清理接收到的AI对话结果
   * 然后将包含Context的内容
   */
  private processAssistantOutput(rawText: string) {
    const start = rawText.indexOf(CONTEXT_OPEN_TAG);
    const end = rawText.indexOf(CONTEXT_CLOSE_TAG, start + CONTEXT_OPEN_TAG.length);
    if (end !== -1) {
      const json = rawText.slice(start + CONTEXT_OPEN_TAG.length, end);
      this.rawContext = json;
    }

    // 回答用户的文本
    const cleanText = rawText.slice(end + CONTEXT_CLOSE_TAG.length);
    return cleanText;
  }

  private buildContextContent() {
    return CONTEXT_OPEN_TAG + this.rawContext + CONTEXT_CLOSE_TAG;
  }

  private syncContextMessage() {
    const firstMessage = this.messages[0];
    const contextContent = this.buildContextContent();

    if (
      firstMessage?.role === "system" &&
      !firstMessage.content.startsWith(CONTEXT_OPEN_TAG)
    ) {
      this.messages = [
        {
          role: "system",
          content: contextContent,
        },
        ...this.messages,
      ];
      return;
    }

    this.messages[0]!.content = contextContent;
  }
}
