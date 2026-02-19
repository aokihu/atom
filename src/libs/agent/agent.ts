/**
 * Agent自动执行单元
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.1
 */

import { inspect } from "node:util";
import { encode } from "@toon-format/toon";
import { generateText, type LanguageModel, type ModelMessage } from "ai";

export class Agent {
  private rawContext: string;
  private context: object;
  private messages: ModelMessage[];
  private model: LanguageModel | undefined;
  private systemPrompt: string | undefined;
  private abortController: AbortController | undefined;

  constructor(arg: { model: LanguageModel; systemPrompt: string }) {
    this.model = arg.model;
    this.systemPrompt = arg.systemPrompt;

    // 上下文原始文字内容
    this.rawContext = "";
    this.context = {};

    // 消息数组
    this.messages = [{ role: "system", content: this.systemPrompt }];

    // 终止控制器
    this.abortController = new AbortController();
  }

  /**
   * 执行一个任务
   */
  async runTask(question: string) {
    const firstMessage = this.messages[0];
    if (
      firstMessage?.role === "system" &&
      !firstMessage.content.startsWith("<context>")
    ) {
      // 插入context内容
      this.messages = [
        {
          role: "system",
          content: "<context>\n" + encode(this.context) + "\n</context>",
        },
        ...this.messages,
      ];
    } else {
      this.messages[0]!.content =
        "<context>" + encode(this.context) + "</context>";
    }

    // 推入用户的会话内容
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
    console.log(this.context);
  }

  /**
   * 清理接收到的AI对话结果
   * 然后将包含Context的内容
   */
  private processAssistantOutput(rawText: string) {
    const start = rawText.indexOf("<context>");
    const end = rawText.indexOf("</context>", start + 9);
    if (end !== -1) {
      const json = rawText.slice(start + 9, end);
      this.rawContext = json;
      try {
        this.context = JSON.parse(json);
      } catch {
        console.log("Invaild JSON string!");
      }
    }

    // 回答用户的文本
    const cleanText = rawText.slice(end + 10);
    return cleanText;
  }
}
