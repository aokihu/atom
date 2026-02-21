/**
 * Agent自动执行单元
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.10
 */

import { inspect } from "node:util";
import { sep } from "node:path";
import { encode } from "@toon-format/toon";
import {
  generateText,
  stepCountIs,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import {
  type LanguageModelV3Middleware,
  type LanguageModelV3,
  type JSONValue,
} from "@ai-sdk/provider";

import type { AgentContext } from "../../types/agent";
import { formatedDatetimeNow } from "../../libs/utils/date";
import { extractContextMiddleware } from "../../libs/utils/ai-sdk/middlewares/extractContextMiddleware";
import tools from "./tools";

// 上下文在用户回答中的分隔符
const CONTEXT_DIVIDE_TAG = "<<<CONTEXT>>>";
const CONTEXT_TAG_START = "<context>";
const CONTEXT_TAG_END = "</context>";

export class Agent {
  // 启动时注入的工作目录，供运行时上下文和后续行为统一使用。
  private workspace: string;
  private rawContext: string;
  private context: AgentContext;
  private messages: ModelMessage[];
  private model: LanguageModelV3 | undefined;
  private systemPrompt: string | undefined;
  private abortController: AbortController | undefined;
  private toolContext: object;

  constructor(arg: {
    model: LanguageModelV3;
    systemPrompt: string;
    workspace: string;
    toolContext?: object;
  }) {
    this.model = arg.model;
    this.systemPrompt = arg.systemPrompt;
    // 统一保证 workspace 以路径分隔符结尾，避免上下文中出现格式不一致的路径。
    const workspace = arg.workspace.endsWith(sep)
      ? arg.workspace
      : `${arg.workspace}${sep}`;
    this.workspace = workspace;

    // 上下文原始文字内容
    this.rawContext = "";
    this.context = {
      version: 2.2,
      runtime: {
        round: 1,
        workspace: this.workspace,
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

    // 尝试使用middleware
    const warpedLanguageModel = wrapLanguageModel({
      model: this.model!,
      middleware: [
        extractContextMiddleware((context) => {
          this.context = context as any as AgentContext;
        }),
      ],
    });

    // 生成用户会话结果
    const { text } = await generateText({
      model: warpedLanguageModel,
      abortSignal: this.abortController?.signal,
      messages: this.messages,
      tools: tools(this.toolContext),
      stopWhen: stepCountIs(10),
    });

    return text;
  }

  /**
   * 流式输出执行任务
   */
  async runAsyncTask(question: string) {}

  displayMessages() {
    console.log(
      inspect(this.messages, { depth: null, colors: true, compact: false }),
    );
  }

  displayContext() {
    console.log(this.context);
  }
}
