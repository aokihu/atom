import { sep } from "node:path";
import type { ModelMessage } from "ai";
import type { AgentContext } from "../../../types/agent";
import { buildContextBlock, CONTEXT_TAG_START } from "./context_codec";
import {
  AgentContextState,
  type AgentContextClock,
} from "./context_state";

export type AgentSessionSnapshot = {
  messages: ModelMessage[];
  context: AgentContext;
};

export class AgentSession {
  private readonly workspace: string;
  private readonly contextState: AgentContextState;
  private rawContext = "";
  private messages: ModelMessage[];

  constructor(args: {
    workspace: string;
    systemPrompt: string;
    contextClock?: AgentContextClock;
  }) {
    const workspace = args.workspace.endsWith(sep)
      ? args.workspace
      : `${args.workspace}${sep}`;

    this.workspace = workspace;
    this.contextState = new AgentContextState({
      workspace: this.workspace,
      clock: args.contextClock,
    });
    this.messages = [{ role: "system", content: args.systemPrompt }];
  }

  mergeExtractedContext(context: Partial<AgentContext>) {
    this.contextState.merge(context);
  }

  prepareUserTurn(question: string) {
    this.injectContext();
    this.messages.push({
      role: "user",
      content: question,
    });
  }

  getMessages() {
    return this.messages;
  }

  getMessagesSnapshot() {
    return structuredClone(this.messages);
  }

  getContextSnapshot() {
    return this.contextState.snapshot();
  }

  snapshot(): AgentSessionSnapshot {
    return {
      messages: this.getMessagesSnapshot(),
      context: this.getContextSnapshot(),
    };
  }

  private injectContext() {
    this.contextState.updateRuntime();

    const contextContent = buildContextBlock(this.contextState.getCurrentContext());
    this.rawContext = contextContent;

    const firstMessage = this.messages[0];
    if (
      firstMessage?.role === "system" &&
      typeof firstMessage.content === "string" &&
      !firstMessage.content.startsWith(CONTEXT_TAG_START)
    ) {
      this.messages = [
        { role: "system", content: contextContent },
        ...this.messages,
      ];
      return;
    }

    if (firstMessage?.role === "system") {
      firstMessage.content = contextContent;
    }
  }
}

