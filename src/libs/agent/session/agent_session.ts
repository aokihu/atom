import { sep } from "node:path";
import type { ModelMessage } from "ai";
import type { AgentContext } from "../../../types/agent";
import { buildContextBlock, CONTEXT_TAG_START } from "./context_codec";
import type { ContextProjectionOptions } from "./context_projection_v2";
import { projectContextSnapshotV2 } from "./context_projection_v2";
import {
  AgentContextState,
  type AgentContextClock,
} from "./context_state";
import { sanitizeIncomingContextPatch } from "./context_sanitizer";

export type AgentSessionSnapshot = {
  messages: ModelMessage[];
  context: AgentContext;
};

export type AgentTaskContextStart = {
  id: string;
  type: string;
  input: string;
  retries: number;
  startedAt: number;
};

export type AgentTaskContextFinish = {
  id: string;
  type: string;
  status: "success" | "failed" | "cancelled";
  finishedAt: number;
  retries: number;
  attempts: number;
};

export type AgentTaskContextFinishOptions = {
  recordLastTask?: boolean;
  preserveCheckpoint?: boolean;
};

type AgentTaskCheckpoint = {
  task_id: string;
  task_type: string;
  saved_at: number;
  retries: number;
  attempts: number;
  working_memory: AgentContext["memory"]["working"];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class AgentSession {
  private readonly workspace: string;
  private readonly contextState: AgentContextState;
  private readonly injectLiteContext: boolean;
  private rawContext = "";
  private messages: ModelMessage[];

  constructor(args: {
    workspace: string;
    systemPrompt: string;
    contextClock?: AgentContextClock;
    injectLiteContext?: boolean;
  }) {
    const workspace = args.workspace.endsWith(sep)
      ? args.workspace
      : `${args.workspace}${sep}`;

    this.workspace = workspace;
    this.contextState = new AgentContextState({
      workspace: this.workspace,
      clock: args.contextClock,
    });
    this.injectLiteContext = args.injectLiteContext ?? true;
    this.messages = [{ role: "system", content: args.systemPrompt }];
  }

  mergeExtractedContext(context: Partial<AgentContext>) {
    this.applyContextPatch(context);
  }

  beginTaskContext(task: AgentTaskContextStart) {
    const checkpoint = this.getTaskCheckpoint();
    const canRestoreCheckpoint = task.retries > 0 && checkpoint?.task_id === task.id;

    this.applyContextPatch({
      active_task: task.input,
      active_task_meta: {
        id: task.id,
        type: task.type,
        status: "running",
        retries: task.retries,
        attempt: task.retries + 1,
        started_at: task.startedAt,
      },
      task_checkpoint: canRestoreCheckpoint ? checkpoint : null,
      memory: {
        working: canRestoreCheckpoint ? checkpoint.working_memory : [],
        ephemeral: [],
      },
    });
  }

  finishTaskContext(task: AgentTaskContextFinish, options?: AgentTaskContextFinishOptions) {
    const recordLastTask = options?.recordLastTask ?? true;
    const preserveCheckpoint = options?.preserveCheckpoint ?? false;
    const checkpoint = preserveCheckpoint ? this.buildTaskCheckpoint(task) : null;

    this.applyContextPatch({
      active_task: null,
      active_task_meta: null,
      task_checkpoint: checkpoint,
      ...(recordLastTask
        ? {
            last_task: {
              id: task.id,
              type: task.type,
              status: task.status,
              finished_at: task.finishedAt,
              retries: task.retries,
              attempts: task.attempts,
            },
          }
        : {}),
      memory: {
        working: [],
        ephemeral: [],
      },
    });
  }

  private getTaskCheckpoint(): AgentTaskCheckpoint | null {
    const contextRecord = this.contextState.getCurrentContext() as Record<string, unknown>;
    const rawCheckpoint = contextRecord.task_checkpoint;
    if (!isPlainObject(rawCheckpoint)) {
      return null;
    }

    const taskId = typeof rawCheckpoint.task_id === "string" ? rawCheckpoint.task_id : null;
    const taskType = typeof rawCheckpoint.task_type === "string" ? rawCheckpoint.task_type : null;
    const savedAt =
      typeof rawCheckpoint.saved_at === "number" && Number.isFinite(rawCheckpoint.saved_at)
        ? rawCheckpoint.saved_at
        : null;
    const retries =
      typeof rawCheckpoint.retries === "number" && Number.isInteger(rawCheckpoint.retries)
        ? rawCheckpoint.retries
        : null;
    const attempts =
      typeof rawCheckpoint.attempts === "number" && Number.isInteger(rawCheckpoint.attempts)
        ? rawCheckpoint.attempts
        : null;
    const workingMemory = Array.isArray(rawCheckpoint.working_memory)
      ? (structuredClone(rawCheckpoint.working_memory) as AgentContext["memory"]["working"])
      : null;

    if (!taskId || !taskType || savedAt === null || retries === null || attempts === null || !workingMemory) {
      return null;
    }

    return {
      task_id: taskId,
      task_type: taskType,
      saved_at: savedAt,
      retries,
      attempts,
      working_memory: workingMemory,
    };
  }

  private buildTaskCheckpoint(task: AgentTaskContextFinish): AgentTaskCheckpoint | null {
    const current = this.contextState.getCurrentContext();
    const workingMemory = structuredClone(current.memory.working);

    if (!Array.isArray(workingMemory) || workingMemory.length === 0) {
      return null;
    }

    return {
      task_id: task.id,
      task_type: task.type,
      saved_at: task.finishedAt,
      retries: task.retries,
      attempts: task.attempts,
      working_memory: workingMemory,
    };
  }

  private applyContextPatch(context: unknown) {
    const sanitizedPatch = sanitizeIncomingContextPatch(
      context,
      this.contextState.getCurrentContext(),
    );
    this.contextState.merge(sanitizedPatch);
  }

  updateRuntimeDiagnostics(fields: {
    budget?: AgentContext["runtime"]["budget"];
    token_usage?: AgentContext["runtime"]["token_usage"];
  }) {
    this.contextState.updateRuntimeDiagnostics(fields);
  }

  prepareUserTurn(
    question: string,
    options?: {
      advanceRound?: boolean;
      projectionOptions?: ContextProjectionOptions;
    },
  ) {
    this.injectContext({
      advanceRound: options?.advanceRound ?? true,
      projectionOptions: options?.projectionOptions,
    });
    this.messages.push({
      role: "user",
      content: question,
    });
  }

  prepareInternalContinuationTurn(
    question: string,
    options?: {
      advanceRound?: boolean;
      projectionOptions?: ContextProjectionOptions;
    },
  ) {
    this.injectContext({
      advanceRound: options?.advanceRound ?? false,
      projectionOptions: options?.projectionOptions,
    });
    this.messages.push({
      role: "user",
      content: question,
    });
  }

  replaceLatestUserTurn(question: string): boolean {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.role === "user") {
        this.messages[index] = {
          ...message,
          content: question,
        };
        return true;
      }
    }
    return false;
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

  getContextProjectionSnapshot(options?: ContextProjectionOptions) {
    return projectContextSnapshotV2(this.contextState.getCurrentContext(), options);
  }

  snapshot(): AgentSessionSnapshot {
    return {
      messages: this.getMessagesSnapshot(),
      context: this.getContextSnapshot(),
    };
  }

  private injectContext(options?: { advanceRound?: boolean; projectionOptions?: ContextProjectionOptions }) {
    this.contextState.refreshRuntime({ advanceRound: options?.advanceRound ?? true });

    const projection = projectContextSnapshotV2(
      this.contextState.getCurrentContext(),
      options?.projectionOptions,
    );
    const payload = this.injectLiteContext ? projection.modelContext : projection.injectedContext;
    const contextContent = buildContextBlock(payload);
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
