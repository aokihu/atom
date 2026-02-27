import { z } from "zod";
import type {
  AgentContext,
  AgentContextMemory,
  AgentContextTodoCursor,
  AgentContextTodoCursorNext,
  ContextMemoryBlock,
  ContextMemoryBlockStatus,
  ContextMemoryTier,
  ContextProjectionDebug,
  ContextProjectionDropReason,
} from "../../../types/agent";
import {
  CONTEXT_MEMORY_TIERS,
  CONTEXT_POLICY,
  getMemoryBlockQuality,
} from "./context_policy";

type PlainRecord = Record<string, unknown>;

type ProjectionBuildResult = {
  injectedContext: AgentContext;
  debug: ContextProjectionDebug;
};

export type SanitizedContextPatch = Record<string, unknown> & {
  memory?: Partial<Record<ContextMemoryTier, ContextMemoryBlock[]>>;
};

const canonicalMemoryBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    decay: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    round: z.number().int().min(1),
    tags: z.array(z.string()),
    content: z.string().min(1),
  })
  .passthrough();

const MAX_DROPPED_SAMPLES_PER_REASON = 5;
const MEMORY_BLOCK_STATUSES = ["open", "done", "failed", "cancelled"] as const;
const TODO_CURSOR_NOTE_MAX_LENGTH = 120;
const TODO_CURSOR_PHASES = ["planning", "doing", "verifying", "blocked"] as const;
const TODO_CURSOR_NEXT_WITH_TARGET = [
  "todo_complete",
  "todo_reopen",
  "todo_update",
  "todo_remove",
] as const satisfies ReadonlyArray<AgentContextTodoCursorNext>;
const TODO_CURSOR_NEXT_WITHOUT_TARGET = [
  "none",
  "todo_list",
  "todo_add",
  "todo_clear_done",
] as const satisfies ReadonlyArray<AgentContextTodoCursorNext>;
const TODO_CURSOR_NEXT_VALUES = [
  ...TODO_CURSOR_NEXT_WITH_TARGET,
  ...TODO_CURSOR_NEXT_WITHOUT_TARGET,
] as const;

type ContextPatchSource = "model" | "system";

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const trimToMax = (text: string, maxLength: number) =>
  text.length > maxLength ? text.slice(0, maxLength) : text;

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

const toPositiveInteger = (value: unknown): number | undefined => {
  const numberValue = toFiniteNumber(value);
  if (numberValue === undefined) {
    return undefined;
  }

  const integerValue = Math.trunc(numberValue);
  if (integerValue < 1) {
    return undefined;
  }

  return integerValue;
};

const toNonEmptyTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const toNonNegativeInteger = (value: unknown): number | undefined => {
  const numberValue = toFiniteNumber(value);
  if (numberValue === undefined) return undefined;
  const integerValue = Math.trunc(numberValue);
  return integerValue >= 0 ? integerValue : undefined;
};

const isTodoCursorNextWithTarget = (value: AgentContextTodoCursorNext): boolean =>
  (TODO_CURSOR_NEXT_WITH_TARGET as readonly string[]).includes(value);

const isTodoCursorNextWithoutTarget = (value: AgentContextTodoCursorNext): boolean =>
  (TODO_CURSOR_NEXT_WITHOUT_TARGET as readonly string[]).includes(value);

const todoCursorSchema = z.object({
  v: z.literal(1),
  phase: z.enum(TODO_CURSOR_PHASES),
  next: z.enum(TODO_CURSOR_NEXT_VALUES),
  targetId: z.number().int().positive().nullable(),
  note: z.string().optional(),
}).strict();

const sanitizeTodoCursor = (value: unknown): AgentContextTodoCursor | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const parsed = todoCursorSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const next = parsed.data.next as AgentContextTodoCursorNext;
  if (isTodoCursorNextWithTarget(next) && parsed.data.targetId === null) {
    return null;
  }
  if (isTodoCursorNextWithoutTarget(next) && parsed.data.targetId !== null) {
    return null;
  }

  const note = parsed.data.note === undefined
    ? undefined
    : toNonEmptyTrimmedString(parsed.data.note);

  if (parsed.data.note !== undefined && !note) {
    return null;
  }

  return {
    v: 1,
    phase: parsed.data.phase,
    next,
    targetId: parsed.data.targetId,
    ...(note ? { note: trimToMax(note, TODO_CURSOR_NOTE_MAX_LENGTH) } : {}),
  };
};

const sanitizeSystemTodoProgressPatch = (value: unknown): PlainRecord | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const summary = typeof value.summary === "string" ? value.summary : undefined;
  const totalRaw = toNonNegativeInteger(value.total);
  const stepRaw = toNonNegativeInteger(value.step);

  const patch: PlainRecord = {};
  if (summary !== undefined) {
    patch.summary = summary;
  }

  if (totalRaw !== undefined || stepRaw !== undefined) {
    const total = totalRaw ?? 0;
    const step = Math.min(stepRaw ?? 0, total);
    patch.total = total;
    patch.step = total === 0 ? 0 : step;
  }

  if (hasOwn(value, "cursor")) {
    if (value.cursor === null) {
      patch.cursor = null;
    } else {
      const cursor = sanitizeTodoCursor(value.cursor);
      if (cursor) {
        patch.cursor = cursor;
      }
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
};

const sanitizeModelTodoPatch = (value: unknown): PlainRecord | null => {
  if (!isPlainObject(value) || !hasOwn(value, "cursor")) {
    return null;
  }

  if (value.cursor === null) {
    return { cursor: null };
  }

  const cursor = sanitizeTodoCursor(value.cursor);
  if (!cursor) {
    return null;
  }

  return { cursor };
};

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const limited = trimToMax(trimmed, CONTEXT_POLICY.tagMaxLength);
    if (seen.has(limited)) continue;
    seen.add(limited);
    tags.push(limited);
    if (tags.length >= CONTEXT_POLICY.tagsMaxItems) break;
  }

  return tags;
};

const normalizeBlockStatus = (value: unknown): ContextMemoryBlockStatus | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim() as ContextMemoryBlockStatus;
  return MEMORY_BLOCK_STATUSES.includes(normalized) ? normalized : undefined;
};

const isTerminalBlockStatus = (status: unknown): status is Exclude<ContextMemoryBlockStatus, "open"> =>
  status === "done" || status === "failed" || status === "cancelled";

const passesProjectionThreshold = (tier: ContextMemoryTier, block: ContextMemoryBlock) => {
  const policy = CONTEXT_POLICY.tiers[tier];
  if (block.decay > policy.maxDecay) return false;
  if (block.confidence < policy.minConfidence) return false;
  return true;
};

const getProjectionThresholdFailureReason = (
  tier: ContextMemoryTier,
  block: ContextMemoryBlock,
): Extract<ContextProjectionDropReason, "threshold_decay" | "threshold_confidence"> | null => {
  const policy = CONTEXT_POLICY.tiers[tier];
  if (block.decay > policy.maxDecay) return "threshold_decay";
  if (block.confidence < policy.minConfidence) return "threshold_confidence";
  return null;
};

const isExpiredByProjectionRound = (
  tier: ContextMemoryTier,
  block: ContextMemoryBlock,
  currentRound: number,
) => {
  const maxAgeRounds = CONTEXT_POLICY.tiers[tier].maxAgeRounds;
  if (maxAgeRounds === undefined) {
    return false;
  }

  const age = currentRound - block.round;
  return age > maxAgeRounds;
};

const isExpiredByRawRetentionRound = (
  tier: ContextMemoryTier,
  block: ContextMemoryBlock,
  currentRound: number,
) => {
  const age = currentRound - block.round;

  if (tier === "ephemeral") {
    return age > CONTEXT_POLICY.rawRetention.ephemeralMaxAgeRounds;
  }

  if (tier === "working" && isTerminalBlockStatus(block.status)) {
    return age > CONTEXT_POLICY.rawRetention.workingTerminalMaxAgeRounds;
  }

  return false;
};

const compareMemoryBlocks = (a: ContextMemoryBlock, b: ContextMemoryBlock) => {
  const qualityDiff = getMemoryBlockQuality(b) - getMemoryBlockQuality(a);
  if (qualityDiff !== 0) return qualityDiff;

  const roundDiff = b.round - a.round;
  if (roundDiff !== 0) return roundDiff;

  return a.id.localeCompare(b.id);
};

const compareRawMemoryBlocks = (tier: ContextMemoryTier, a: ContextMemoryBlock, b: ContextMemoryBlock) => {
  if (tier === "working") {
    const aTerminal = isTerminalBlockStatus(a.status);
    const bTerminal = isTerminalBlockStatus(b.status);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
  }

  const roundDiff = b.round - a.round;
  if (roundDiff !== 0) return roundDiff;

  return compareMemoryBlocks(a, b);
};

const choosePreferredBlock = (a: ContextMemoryBlock, b: ContextMemoryBlock) => {
  const qualityA = getMemoryBlockQuality(a);
  const qualityB = getMemoryBlockQuality(b);

  if (qualityB > qualityA) return b;
  if (qualityA > qualityB) return a;

  return b.round >= a.round ? b : a;
};

const choosePreferredRawBlock = (
  tier: ContextMemoryTier,
  a: ContextMemoryBlock,
  b: ContextMemoryBlock,
) => {
  if (tier === "working") {
    const aTerminal = isTerminalBlockStatus(a.status);
    const bTerminal = isTerminalBlockStatus(b.status);
    if (aTerminal !== bTerminal) {
      return aTerminal ? b : a;
    }
  }

  return choosePreferredBlock(a, b);
};

const normalizeMemoryBlock = (
  value: unknown,
  tier: ContextMemoryTier,
  currentRound: number,
): ContextMemoryBlock | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = toNonEmptyTrimmedString(value.id);
  const type = toNonEmptyTrimmedString(value.type);
  const contentRaw = toNonEmptyTrimmedString(value.content);
  const decayNumber = toFiniteNumber(value.decay);
  const confidenceNumber =
    value.confidence === undefined
      ? CONTEXT_POLICY.defaultConfidence
      : toFiniteNumber(value.confidence);

  if (!id || !type || !contentRaw || decayNumber === undefined || confidenceNumber === undefined) {
    return null;
  }

  const parsedRound = toPositiveInteger(value.round) ?? currentRound;
  const round = Math.min(parsedRound, currentRound);
  const normalizedContent = trimToMax(contentRaw, CONTEXT_POLICY.contentMaxLength);
  const normalizedStatus = normalizeBlockStatus(value.status);

  const normalized: PlainRecord = { ...value };
  normalized.id = id;
  normalized.type = type;
  normalized.content = normalizedContent;
  normalized.decay = clamp01(decayNumber);
  normalized.confidence = clamp01(confidenceNumber);
  normalized.round = round;
  normalized.tags = normalizeTags(value.tags);

  if (tier === "working") {
    normalized.status = normalizedStatus ?? "open";
  } else if (normalizedStatus) {
    normalized.status = normalizedStatus;
  }

  const parsed = canonicalMemoryBlockSchema.safeParse(normalized);
  if (!parsed.success) {
    return null;
  }

  return parsed.data as ContextMemoryBlock;
};

const sanitizeTierBlocksHard = (
  input: unknown,
  tier: ContextMemoryTier,
  currentRound: number,
): ContextMemoryBlock[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const byId = new Map<string, ContextMemoryBlock>();

  for (const item of input) {
    const block = normalizeMemoryBlock(item, tier, currentRound);
    if (!block) continue;

    const existing = byId.get(block.id);
    if (!existing) {
      byId.set(block.id, block);
      continue;
    }

    byId.set(block.id, choosePreferredRawBlock(tier, existing, block));
  }

  return Array.from(byId.values()).sort((a, b) => compareRawMemoryBlocks(tier, a, b));
};

const deepMergeValue = (currentValue: unknown, patchValue: unknown): unknown => {
  if (patchValue === undefined) {
    return currentValue;
  }

  if (Array.isArray(patchValue)) {
    return structuredClone(patchValue);
  }

  if (!isPlainObject(patchValue)) {
    return patchValue;
  }

  if (!isPlainObject(currentValue)) {
    const created: PlainRecord = {};
    for (const [key, value] of Object.entries(patchValue)) {
      created[key] = deepMergeValue(undefined, value);
    }
    return created;
  }

  const merged: PlainRecord = { ...currentValue };
  for (const [key, value] of Object.entries(patchValue)) {
    merged[key] = deepMergeValue(currentValue[key], value);
  }

  return merged;
};

const mergeMemoryTierById = (
  existingBlocks: ContextMemoryBlock[],
  incomingBlocks: ContextMemoryBlock[],
): ContextMemoryBlock[] => {
  if (incomingBlocks.length === 0) {
    return [];
  }

  const byId = new Map<string, ContextMemoryBlock>();

  for (const block of existingBlocks) {
    byId.set(block.id, structuredClone(block));
  }

  for (const block of incomingBlocks) {
    const existing = byId.get(block.id);
    if (!existing) {
      byId.set(block.id, structuredClone(block));
      continue;
    }

    byId.set(block.id, { ...existing, ...structuredClone(block) });
  }

  return Array.from(byId.values());
};

const createEmptyMemory = (): AgentContextMemory => ({
  core: [],
  working: [],
  ephemeral: [],
  longterm: [],
});

const createZeroTierCounts = (): Record<ContextMemoryTier, number> => ({
  core: 0,
  working: 0,
  ephemeral: 0,
  longterm: 0,
});

const createProjectionDebug = (round: number): ContextProjectionDebug => ({
  round,
  rawCounts: createZeroTierCounts(),
  injectedCounts: createZeroTierCounts(),
  droppedByReason: {
    working_status_terminal: 0,
    threshold_decay: 0,
    threshold_confidence: 0,
    expired_by_round: 0,
    over_max_items: 0,
    invalid_block: 0,
  },
  droppedSamples: {},
});

const recordProjectionDrop = (
  debug: ContextProjectionDebug,
  reason: ContextProjectionDropReason,
  tier: ContextMemoryTier,
  block: Partial<Pick<ContextMemoryBlock, "id" | "type">> | null,
) => {
  debug.droppedByReason[reason] += 1;

  const samples = (debug.droppedSamples[reason] ??= []);
  if (samples.length >= MAX_DROPPED_SAMPLES_PER_REASON) {
    return;
  }

  samples.push({
    tier,
    id: block?.id,
    type: block?.type,
  });
};

const stripProjectionOnlyTopLevelFields = (context: AgentContext) => {
  const record = context as Record<string, unknown>;
  delete record.task_checkpoint;
  delete record.last_task;
};

export const sanitizeIncomingContextPatchHard = (
  input: unknown,
  currentContext: Pick<AgentContext, "runtime">,
  options?: { source?: ContextPatchSource },
): SanitizedContextPatch => {
  if (!isPlainObject(input)) {
    return {};
  }

  const source = options?.source ?? "model";
  const patch: SanitizedContextPatch = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "runtime" || key === "version" || key === "memory" || key === "todo") {
      continue;
    }
    patch[key] = value;
  }

  if (hasOwn(input, "todo")) {
    const todoPatch = source === "system"
      ? sanitizeSystemTodoProgressPatch(input.todo)
      : sanitizeModelTodoPatch(input.todo);
    if (todoPatch) {
      patch.todo = todoPatch;
    }
  }

  const rawMemory = input.memory;
  if (!isPlainObject(rawMemory)) {
    return patch;
  }

  const memoryPatch: Partial<Record<ContextMemoryTier, ContextMemoryBlock[]>> = {};
  let hasMemoryPatch = false;

  for (const tier of CONTEXT_MEMORY_TIERS) {
    if (!hasOwn(rawMemory, tier)) {
      continue;
    }

    const rawTierValue = rawMemory[tier];
    if (!Array.isArray(rawTierValue)) {
      continue;
    }

    memoryPatch[tier] = sanitizeTierBlocksHard(rawTierValue, tier, currentContext.runtime.round);
    hasMemoryPatch = true;
  }

  if (hasMemoryPatch) {
    patch.memory = memoryPatch;
  }

  return patch;
};

export const sanitizeIncomingContextPatch = (
  input: unknown,
  currentContext: Pick<AgentContext, "runtime">,
) => sanitizeIncomingContextPatchHard(input, currentContext, { source: "model" });

export const mergeContextWithMemoryPolicy = (
  current: AgentContext,
  patch: SanitizedContextPatch,
): AgentContext => {
  const merged = structuredClone(current) as AgentContext;

  for (const [key, value] of Object.entries(patch)) {
    if (key === "runtime" || key === "version" || key === "memory") {
      continue;
    }

    merged[key] = deepMergeValue(merged[key], value);
  }

  const patchMemory = patch.memory;
  if (patchMemory) {
    const nextMemory: AgentContextMemory = {
      core: [...merged.memory.core],
      working: [...merged.memory.working],
      ephemeral: [...merged.memory.ephemeral],
      longterm: [...merged.memory.longterm],
    };

    for (const tier of CONTEXT_MEMORY_TIERS) {
      if (!hasOwn(patchMemory, tier)) {
        continue;
      }

      const incomingTierBlocks = patchMemory[tier] ?? [];
      nextMemory[tier] = mergeMemoryTierById(nextMemory[tier], incomingTierBlocks);
    }

    merged.memory = nextMemory;
  }

  merged.runtime = structuredClone(current.runtime);
  merged.version = current.version;
  return merged;
};

export const compactRawContextForStorage = (context: AgentContext): AgentContext => {
  const next = structuredClone(context) as AgentContext;
  const rawContext = context as Record<string, unknown>;
  const rawMemory = isPlainObject(rawContext.memory) ? rawContext.memory : {};
  const currentRound = context.runtime.round;

  next.memory = createEmptyMemory();

  for (const tier of CONTEXT_MEMORY_TIERS) {
    const rawTierValue = rawMemory[tier];
    const normalizedBlocks = sanitizeTierBlocksHard(rawTierValue, tier, currentRound).filter(
      (block) => !isExpiredByRawRetentionRound(tier, block, currentRound),
    );

    next.memory[tier] = normalizedBlocks.slice(0, CONTEXT_POLICY.rawRetention.tiers[tier].maxItems);
  }

  next.runtime = structuredClone(context.runtime);
  next.version = context.version;
  return next;
};

export const buildInjectedContextProjection = (rawContext: AgentContext): ProjectionBuildResult => {
  const injectedContext = structuredClone(rawContext) as AgentContext;
  const rawRecord = rawContext as Record<string, unknown>;
  const rawMemory = isPlainObject(rawRecord.memory) ? rawRecord.memory : {};
  const currentRound = rawContext.runtime.round;
  const debug = createProjectionDebug(currentRound);

  stripProjectionOnlyTopLevelFields(injectedContext);
  injectedContext.memory = createEmptyMemory();

  for (const tier of CONTEXT_MEMORY_TIERS) {
    const rawTierValue = rawMemory[tier];
    const rawItems = Array.isArray(rawTierValue) ? rawTierValue : [];
    debug.rawCounts[tier] = rawItems.length;

    const deduped = new Map<string, ContextMemoryBlock>();

    for (const item of rawItems) {
      const block = normalizeMemoryBlock(item, tier, currentRound);
      if (!block) {
        recordProjectionDrop(debug, "invalid_block", tier, isPlainObject(item) ? item : null);
        continue;
      }

      if (tier === "working" && isTerminalBlockStatus(block.status)) {
        recordProjectionDrop(debug, "working_status_terminal", tier, block);
        continue;
      }

      const thresholdFailure = getProjectionThresholdFailureReason(tier, block);
      if (thresholdFailure) {
        recordProjectionDrop(debug, thresholdFailure, tier, block);
        continue;
      }

      if (isExpiredByProjectionRound(tier, block, currentRound)) {
        recordProjectionDrop(debug, "expired_by_round", tier, block);
        continue;
      }

      const existing = deduped.get(block.id);
      if (!existing) {
        deduped.set(block.id, block);
        continue;
      }

      deduped.set(block.id, choosePreferredBlock(existing, block));
    }

    const projected = Array.from(deduped.values()).sort(compareMemoryBlocks);
    const maxItems = CONTEXT_POLICY.tiers[tier].maxItems;
    if (projected.length > maxItems) {
      for (const block of projected.slice(maxItems)) {
        recordProjectionDrop(debug, "over_max_items", tier, block);
      }
    }

    injectedContext.memory[tier] = projected.slice(0, maxItems);
    debug.injectedCounts[tier] = injectedContext.memory[tier].length;
  }

  injectedContext.runtime = structuredClone(rawContext.runtime);
  injectedContext.version = rawContext.version;

  return {
    injectedContext,
    debug,
  };
};

export const __contextSanitizerInternals = {
  sanitizeTierBlocksHard,
  normalizeMemoryBlock,
  isPlainObject,
  isExpiredByProjectionRound,
  isExpiredByRawRetentionRound,
  passesProjectionThreshold,
};
