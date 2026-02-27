/**
 * Agent自动执行单元（兼容门面）
 */

import { inspect } from "node:util";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  AgentContextProjectionSnapshot,
  AgentModelParams,
} from "../../types/agent";

import {
  AgentControlledStopError,
  AgentRunner,
  type AgentDependencies,
  type AgentRunDetailedResult,
  type AgentRunOptions,
} from "./core/agent_runner";
import {
  AgentSession,
  type AgentTaskContextFinish,
  type AgentTaskContextFinishOptions,
  type AgentTaskContextStart,
  type AgentSessionSnapshot,
} from "./session/agent_session";
import type { ToolDefinitionMap, ToolExecutionContext } from "./tools";

export type {
  AgentDependencies,
  AgentRunDetailedResult,
  AgentRunOptions,
  AgentSessionSnapshot,
  ToolDefinitionMap,
  ToolExecutionContext,
};
export { AgentControlledStopError };

export class Agent {
  private readonly session: AgentSession;
  private readonly runner: AgentRunner;

  constructor(arg: {
    model: LanguageModelV3;
    modelParams?: AgentModelParams;
    systemPrompt: string;
    workspace: string;
    toolContext?: ToolExecutionContext;
    mcpTools?: ToolDefinitionMap;
    dependencies?: AgentDependencies;
  }) {
    this.session = new AgentSession({
      workspace: arg.workspace,
      systemPrompt: arg.systemPrompt,
    });
    this.runner = new AgentRunner({
      model: arg.model,
      modelParams: arg.modelParams,
      toolContext: arg.toolContext,
      mcpTools: arg.mcpTools,
      dependencies: arg.dependencies,
    });
  }

  /**
   * 执行一个任务
   */
  async runTask(question: string, options?: AgentRunOptions) {
    return await this.runner.runTask(this.session, question, options);
  }

  async runTaskDetailed(question: string, options?: AgentRunOptions): Promise<AgentRunDetailedResult> {
    return await this.runner.runTaskDetailed(this.session, question, options);
  }

  /**
   * 流式输出执行任务（兼容保留，当前不对外返回流）
   */
  async runAsyncTask(question: string, options?: AgentRunOptions) {
    const result = await this.runner.runTaskStream(this.session, question, options);

    for await (const _textPart of result.textStream) {
      // 保持旧行为：消费流但不输出
    }
  }

  getMessagesSnapshot() {
    return this.session.getMessagesSnapshot();
  }

  getContextSnapshot() {
    return this.session.getContextSnapshot();
  }

  getContextProjectionSnapshot(): AgentContextProjectionSnapshot {
    return this.session.getContextProjectionSnapshot();
  }

  getSessionSnapshot(): AgentSessionSnapshot {
    return this.session.snapshot();
  }

  abortCurrentRun(reason?: string): boolean {
    return this.runner.abortCurrentRun(reason);
  }

  beginTaskContext(task: AgentTaskContextStart) {
    this.session.beginTaskContext(task);
  }

  finishTaskContext(task: AgentTaskContextFinish, options?: AgentTaskContextFinishOptions) {
    this.session.finishTaskContext(task, options);
  }

  displayMessages() {
    console.log(
      inspect(this.getMessagesSnapshot(), {
        depth: null,
        colors: true,
        compact: false,
      }),
    );
  }

  displayContext() {
    console.log(
      inspect(this.getContextSnapshot(), {
        depth: null,
        colors: true,
        compact: false,
      }),
    );
  }
}
