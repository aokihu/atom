/**
 * Agent自动执行单元
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.1
 */

import { inspect } from "node:util";
import { encode } from "@toon-format/toon";
import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import tools from "./tools";

const CONTEXT_TAG_START = "<context>";
const CONTEXT_TAG_END = "</context>";

export class Agent {
  private rawContext: string;
  private context: object;
  private messages: ModelMessage[];
  private model: LanguageModel | undefined;
  private systemPrompt: string | undefined;
  private abortController: AbortController | undefined;
  private toolContext: object;

  constructor(arg: {
    model: LanguageModel;
    systemPrompt: string;
    toolContext?: object;
  }) {
    this.model = arg.model;
    this.systemPrompt = arg.systemPrompt;

    // 上下文原始文字内容
    this.rawContext = "";
    this.context = {
      version: 2.2,
      runtime: {
        round: 1,
        datetime: Date.now(),
        startup_at: Date.now(),
      },
    };

    // 消息数组
    this.messages = [{ role: "system", content: this.systemPrompt }];

    // 终止控制器
    this.abortController = new AbortController();
    this.toolContext = arg.toolContext ?? {};
  }

  /**
   * 向Messages中注入上下文信息
   */
  private injectContext() {
    const firstMessage = this.messages[0];
    const contextContent = [
      CONTEXT_TAG_START,
      encode(this.context),
      CONTEXT_TAG_END,
    ].join("\n");

    if (
      firstMessage?.role === "system" &&
      !firstMessage.content.startsWith(CONTEXT_TAG_START)
    ) {
      // 插入context内容
      this.messages = [
        {
          role: "system",
          content: contextContent,
        },
        ...this.messages,
      ];
    } else {
      this.messages[0]!.content = contextContent;
    }
  }

  /**
   * 执行一个任务
   */
  async runTask(question: string) {
    // 注入上下文数据
    this.injectContext();

    // 推入用户的会话内容
    this.messages.push({
      role: "user",
      content: question,
    });

    // 生成用户会话结果
    const { text, response } = await generateText({
      model: this.model!,
      abortSignal: this.abortController?.signal,
      messages: this.messages,
      tools: tools(this.toolContext),
      stopWhen: stepCountIs(7),
    });

    // 清理接收到的助理消息
    // 将context内容保存到this.rawContext
    // 只将非context内容保存到历史消息中

    const lastMessage = response.messages.reverse()[0];
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
    const start = rawText.indexOf(CONTEXT_TAG_START);
    const end = rawText.indexOf(
      CONTEXT_TAG_END,
      start + CONTEXT_TAG_START.length,
    );
    if (end !== -1) {
      const json = rawText.slice(start + CONTEXT_TAG_START.length, end);
      this.rawContext = json;
      try {
        this.context = JSON.parse(json);
      } catch {
        console.log("Invaild JSON string!");
      }
    }

    // 回答用户的文本
    const cleanText = rawText.slice(end + CONTEXT_TAG_END.length).trimStart();
    return cleanText;
  }
}
