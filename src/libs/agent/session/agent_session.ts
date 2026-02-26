import { sep } from "node:path";
import type { ModelMessage } from "ai";
import type {
  AgentContext,
  AgentContextProjectionSnapshot,
  AgentContextRuntime,
  ContextMemoryBlock,
  ContextMemoryBlockStatus,
} from "../../../types/agent";
import { buildContextBlock, CONTEXT_TAG_START } from "./context_codec";
import {
  AgentContextState,
  type AgentContextClock,
} from "./context_state";
import { sanitizeIncomingContextPatchHard } from "./context_sanitizer";

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

const isTerminalWorkingStatus = (status: unknown): status is Exclude<ContextMemoryBlockStatus, "open"> =>
  status === "done" || status === "failed" || status === "cancelled";

const isOpenWorkingBlock = (block: ContextMemoryBlock) =>
  block.status === undefined || block.status === "open";

const toFiniteNonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : undefined;
};

const getCurrentUsageTotalTokens = (
  usage: Pick<NonNullable<AgentContextRuntime["token_usage"]>, "total_tokens" | "input_tokens" | "output_tokens">,
): number | undefined => {
  if (typeof usage.total_tokens === "number") {
    return usage.total_tokens;
  }

  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const fallback = input + output;
  return fallback > 0 ? fallback : undefined;
};

const normalizeRuntimeTokenUsageFromSDK = (
  usage: unknown,
  updatedAt: number,
): NonNullable<AgentContextRuntime["token_usage"]> | null => {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return null;
  }

  const record = usage as Record<string, unknown>;
  const normalized: NonNullable<AgentContextRuntime["token_usage"]> = {
    source: "ai-sdk",
    updated_at: updatedAt,
  };

  const mappings = [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["totalTokens", "total_tokens"],
    ["reasoningTokens", "reasoning_tokens"],
    ["cachedInputTokens", "cached_input_tokens"],
  ] as const satisfies ReadonlyArray<
    readonly [string, keyof NonNullable<AgentContextRuntime["token_usage"]>]
  >;

  let hasTokenField = false;
  for (const [sdkKey, runtimeKey] of mappings) {
    const parsed = toFiniteNonNegativeInteger(record[sdkKey]);
    if (parsed === undefined) {
      continue;
    }
    normalized[runtimeKey] = parsed;
    hasTokenField = true;
  }

  if (!hasTokenField) {
    return null;
  }

  return normalized;
};

export class AgentSession {
  private readonly workspace: string;
  private readonly baseSystemPrompt: string;
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
    this.baseSystemPrompt = args.systemPrompt;
    this.contextState = new AgentContextState({
      workspace: this.workspace,
      clock: args.contextClock,
    });
    this.messages = [{ role: "system", content: this.baseSystemPrompt }];
  }

  mergeExtractedContext(context: Partial<AgentContext>) {
    this.applyContextPatch(context);
  }

  recordRuntimeTokenUsageFromSDK(usage: unknown) {
    const normalizedUsage = normalizeRuntimeTokenUsageFromSDK(
      usage,
      this.contextState.nowTimestamp(),
    );
    if (!normalizedUsage) {
      return;
    }

    const currentTokenUsage = this.contextState.getCurrentContext().runtime.token_usage;
    const previousCumulativeTotalTokens =
      toFiniteNonNegativeInteger(currentTokenUsage?.cumulative_total_tokens) ?? 0;
    const currentUsageTotalTokens = getCurrentUsageTotalTokens(normalizedUsage) ?? 0;

    this.contextState.updateRuntimeTokenUsage({
      ...normalizedUsage,
      cumulative_total_tokens: previousCumulativeTotalTokens + currentUsageTotalTokens,
    });
  }

  beginTaskContext(task: AgentTaskContextStart) {
    this.resetTaskConversationMessages();

    const checkpoint = this.getTaskCheckpoint();
    const canRestoreCheckpoint = task.retries > 0 && checkpoint?.task_id === task.id;
    const closedStaleWorkingMemory = this.closeOpenWorkingBlocksAtTaskBoundary(task.startedAt);
    const restoredWorkingMemory = canRestoreCheckpoint
      ? checkpoint.working_memory.map((block) => ({
          ...structuredClone(block),
          status: "open" as const,
          task_id: task.id,
        }))
      : undefined;

    const patch: Record<string, unknown> = {
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
    };

    const nextWorkingPatch = restoredWorkingMemory
      ? [...closedStaleWorkingMemory, ...restoredWorkingMemory]
      : closedStaleWorkingMemory;

    if (nextWorkingPatch.length > 0) {
      patch.memory = {
        working: nextWorkingPatch,
      };
    }

    this.applyContextPatch(patch);
  }

  finishTaskContext(task: AgentTaskContextFinish, options?: AgentTaskContextFinishOptions) {
    const recordLastTask = options?.recordLastTask ?? true;
    const preserveCheckpoint = options?.preserveCheckpoint ?? false;
    const checkpoint = preserveCheckpoint ? this.buildTaskCheckpoint(task) : null;
    const workingStatus = this.toWorkingTerminalStatus(task.status);
    const markedWorkingMemory = this.markAllWorkingBlocksStatus(workingStatus, task);

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
        working: markedWorkingMemory,
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
    const workingMemory = structuredClone(
      current.memory.working.filter((block) => isOpenWorkingBlock(block)),
    );

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

  private toWorkingTerminalStatus(
    status: AgentTaskContextFinish["status"],
  ): Exclude<ContextMemoryBlockStatus, "open"> {
    switch (status) {
      case "success":
        return "done";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
    }
  }

  private markAllWorkingBlocksStatus(
    status: Exclude<ContextMemoryBlockStatus, "open">,
    task: Pick<AgentTaskContextFinish, "id" | "finishedAt">,
  ): AgentContext["memory"]["working"] {
    const current = this.contextState.getCurrentContext();

    return current.memory.working.map((block) => {
      const cloned = structuredClone(block) as ContextMemoryBlock;
      if (isTerminalWorkingStatus(cloned.status)) {
        return cloned;
      }

      return {
        ...cloned,
        status,
        task_id: task.id,
        closed_at: task.finishedAt,
      };
    });
  }

  private closeOpenWorkingBlocksAtTaskBoundary(closedAt: number): AgentContext["memory"]["working"] {
    const current = this.contextState.getCurrentContext();
    let changed = false;

    const nextWorking = current.memory.working.map((block) => {
      const cloned = structuredClone(block) as ContextMemoryBlock;
      if (isTerminalWorkingStatus(cloned.status)) {
        return cloned;
      }

      changed = true;
      return {
        ...cloned,
        status: "cancelled" as const,
        closed_at: closedAt,
      };
    });

    return changed ? nextWorking : [];
  }

  private applyContextPatch(context: unknown) {
    const sanitizedPatch = sanitizeIncomingContextPatchHard(
      context,
      this.contextState.getCurrentContext(),
    );
    this.contextState.merge(sanitizedPatch);
  }

  private resetTaskConversationMessages() {
    this.messages = [{ role: "system", content: this.baseSystemPrompt }];
  }

  prepareUserTurn(question: string) {
    this.injectContext({ advanceRound: true });
    this.messages.push({
      role: "user",
      content: question,
    });
  }

  prepareInternalContinuationTurn(
    question: string,
    options?: {
      advanceRound?: boolean;
    },
  ) {
    this.injectContext({ advanceRound: options?.advanceRound ?? false });
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

  getContextProjectionSnapshot(): AgentContextProjectionSnapshot {
    return this.contextState.snapshotWithProjectionDebug();
  }

  snapshot(): AgentSessionSnapshot {
    return {
      messages: this.getMessagesSnapshot(),
      context: this.getContextSnapshot(),
    };
  }

  private injectContext(options?: { advanceRound?: boolean }) {
    this.contextState.refreshRuntime({ advanceRound: options?.advanceRound ?? true });

    const contextContent = buildContextBlock(this.contextState.snapshotInjected());
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
