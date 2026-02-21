/**
 * Agent自动执行单元
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.1
 */

import { inspect } from "node:util";
import { encode } from "@toon-format/toon";
import { set } from "radashi";
import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { formatedDatetimeNow } from "../../libs/utils/date";
import tools from "./tools";
import type { AgentContext } from "../../types/agent";

// 上下文在用户回答中的分隔符
const CONTEXT_DIVIDE_TAG = "<<<CONTEXT>>>";
const CONTEXT_TAG_START = "<context>";
const CONTEXT_TAG_END = "</context>";

export class Agent {
  private rawContext: string;
  private context: AgentContext;
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
        workspace: process.cwd() + "/", // 暂时使用这个方法获取工作路径,因为在启动参数的时候有指定工作路径的参数
        datetime: formatedDatetimeNow(),
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
   * 更新上下文内容
   */
  private updateConetxt() {
    this.context.runtime.round += 1;
    this.context.runtime.datetime = formatedDatetimeNow();
  }

  /**
   * 向Messages中注入上下文信息
   */
  private injectContext() {
    this.updateConetxt(); // 更新上下文中的一些数据

    // 插入上下文
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
      stopWhen: stepCountIs(10),
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
    const divide_start = rawText.indexOf(CONTEXT_DIVIDE_TAG);

    let cleanedText = rawText;

    if (divide_start >= 0) {
      const contextRawText = rawText.slice(
        divide_start + CONTEXT_DIVIDE_TAG.length,
      );
      try {
        this.context = JSON.parse(contextRawText);
        cleanedText = cleanedText.slice(0, divide_start).trimEnd().trimStart();
      } catch {
        throw new Error("Invaild JSON string!");
      }
    }

    return cleanedText;
  }
}
