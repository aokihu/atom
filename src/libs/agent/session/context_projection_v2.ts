import type {
  AgentContext,
  AgentContextProjectionSnapshot,
  ContextMemoryTier,
  ContextProjectionCounts,
  ModelContextV2,
} from "../../../types/agent";
import { CONTEXT_MEMORY_TIERS, CONTEXT_POLICY } from "./context_policy";
import { compactContextMemory } from "./context_sanitizer";
import { toModelContextV2 } from "./context_model_v2";

export type ContextProjectionOptions = {
  maxItemsByTier?: Partial<Record<ContextMemoryTier, number>>;
  tokenBudget?: number;
  dropTerminalWorking?: boolean;
};

const TERMINAL_WORKING_STATUS = new Set(["done", "failed", "cancelled", "completed"]);

const estimateTokens = (value: unknown): number => {
  let text = "";
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }

  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
};

const createCounts = (): ContextProjectionCounts => ({
  core: 0,
  working: 0,
  ephemeral: 0,
  longterm: 0,
});

const buildCounts = (context: AgentContext): ContextProjectionCounts => {
  const counts = createCounts();
  for (const tier of CONTEXT_MEMORY_TIERS) {
    const list = context.memory[tier] ?? [];
    counts[tier] = Array.isArray(list) ? list.length : 0;
  }
  return counts;
};

const cloneContext = (context: AgentContext): AgentContext => structuredClone(context);

const toMetaRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const trimTier = (
  context: AgentContext,
  tier: ContextMemoryTier,
  limit: number,
  droppedByReason: Record<string, number>,
): void => {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const list = context.memory[tier] ?? [];
  if (!Array.isArray(list) || list.length <= normalizedLimit) {
    return;
  }
  droppedByReason.over_max_items = (droppedByReason.over_max_items ?? 0) + (list.length - normalizedLimit);
  context.memory[tier] = list.slice(0, normalizedLimit);
};

const dropTerminalWorking = (
  context: AgentContext,
  droppedByReason: Record<string, number>,
): void => {
  const working = context.memory.working;
  if (!Array.isArray(working) || working.length === 0) {
    return;
  }

  const next = working.filter((block) => {
    const meta = toMetaRecord(block);
    const status = typeof meta?.status === "string" ? meta.status.toLowerCase() : "";
    return !TERMINAL_WORKING_STATUS.has(status);
  });

  if (next.length !== working.length) {
    droppedByReason.working_status_terminal =
      (droppedByReason.working_status_terminal ?? 0) + (working.length - next.length);
    context.memory.working = next;
  }
};

const applyTokenBudget = (
  context: AgentContext,
  tokenBudget: number,
  droppedByReason: Record<string, number>,
): void => {
  const tiers: ContextMemoryTier[] = ["ephemeral", "working", "longterm", "core"];

  let modelContext: ModelContextV2 = toModelContextV2(context);
  if (estimateTokens(modelContext) <= tokenBudget) {
    return;
  }

  for (const tier of tiers) {
    const list = context.memory[tier];
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }

    for (let length = list.length - 1; length >= 0; length -= 1) {
      context.memory[tier] = list.slice(0, length);
      modelContext = toModelContextV2(context);
      if (estimateTokens(modelContext) <= tokenBudget) {
        droppedByReason.token_budget_trimmed =
          (droppedByReason.token_budget_trimmed ?? 0) + (list.length - length);
        return;
      }
    }

    droppedByReason.token_budget_trimmed =
      (droppedByReason.token_budget_trimmed ?? 0) + list.length;
    context.memory[tier] = [];
  }
};

export const projectContextSnapshotV2 = (
  rawContext: AgentContext,
  options?: ContextProjectionOptions,
): AgentContextProjectionSnapshot => {
  const context = compactContextMemory(cloneContext(rawContext));
  const injectedContext = compactContextMemory(cloneContext(context));

  const droppedByReason: Record<string, number> = {
    working_status_terminal: 0,
    threshold_decay: 0,
    threshold_confidence: 0,
    expired_by_round: 0,
    over_max_items: 0,
    invalid_block: 0,
    token_budget_trimmed: 0,
  };

  if (options?.dropTerminalWorking !== false) {
    dropTerminalWorking(injectedContext, droppedByReason);
  }

  for (const tier of CONTEXT_MEMORY_TIERS) {
    const configured = options?.maxItemsByTier?.[tier] ?? CONTEXT_POLICY.tiers[tier].maxItems;
    trimTier(injectedContext, tier, configured, droppedByReason);
  }

  if (
    typeof options?.tokenBudget === "number" &&
    Number.isFinite(options.tokenBudget) &&
    options.tokenBudget > 0
  ) {
    applyTokenBudget(injectedContext, options.tokenBudget, droppedByReason);
  }

  const modelContext = toModelContextV2(injectedContext);

  return {
    context,
    injectedContext,
    modelContext,
    projectionDebug: {
      round: context.runtime.round,
      rawCounts: buildCounts(context),
      injectedCounts: buildCounts(injectedContext),
      droppedByReason,
      droppedSamples: {},
    },
  };
};

export type ContextLiteMeta = {
  rawContextBytes: number;
  modelContextBytes: number;
  projectionDebug?: AgentContextProjectionSnapshot["projectionDebug"];
};

export const buildContextLiteMeta = (snapshot: AgentContextProjectionSnapshot): ContextLiteMeta => ({
  rawContextBytes: Buffer.byteLength(JSON.stringify(snapshot.context), "utf8"),
  modelContextBytes: Buffer.byteLength(JSON.stringify(snapshot.modelContext), "utf8"),
  projectionDebug: snapshot.projectionDebug,
});
