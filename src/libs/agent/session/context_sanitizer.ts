import { z } from "zod";
import type {
  AgentContext,
  AgentContextMemory,
  ContextMemoryBlock,
  ContextMemoryTier,
} from "../../../types/agent";
import {
  CONTEXT_MEMORY_TIERS,
  CONTEXT_POLICY,
  getMemoryBlockQuality,
} from "./context_policy";

type PlainRecord = Record<string, unknown>;

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

const passesTierThreshold = (tier: ContextMemoryTier, block: ContextMemoryBlock) => {
  const policy = CONTEXT_POLICY.tiers[tier];
  return block.decay <= policy.maxDecay && block.confidence >= policy.minConfidence;
};

const compareMemoryBlocks = (a: ContextMemoryBlock, b: ContextMemoryBlock) => {
  const qualityDiff = getMemoryBlockQuality(b) - getMemoryBlockQuality(a);
  if (qualityDiff !== 0) return qualityDiff;

  const roundDiff = b.round - a.round;
  if (roundDiff !== 0) return roundDiff;

  return a.id.localeCompare(b.id);
};

const choosePreferredBlock = (a: ContextMemoryBlock, b: ContextMemoryBlock) => {
  const qualityA = getMemoryBlockQuality(a);
  const qualityB = getMemoryBlockQuality(b);

  if (qualityB > qualityA) return b;
  if (qualityA > qualityB) return a;

  return b.round >= a.round ? b : a;
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

  const round = toPositiveInteger(value.round) ?? currentRound;
  const normalizedContent = trimToMax(contentRaw, CONTEXT_POLICY.contentMaxLength);

  const normalized: PlainRecord = { ...value };
  normalized.id = id;
  normalized.type = type;
  normalized.content = normalizedContent;
  normalized.decay = clamp01(decayNumber);
  normalized.confidence = clamp01(confidenceNumber);
  normalized.round = round;
  normalized.tags = normalizeTags(value.tags);

  const parsed = canonicalMemoryBlockSchema.safeParse(normalized);
  if (!parsed.success) {
    return null;
  }

  const block = parsed.data as ContextMemoryBlock;
  if (!passesTierThreshold(tier, block)) {
    return null;
  }

  return block;
};

const sanitizeTierBlocks = (
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

    byId.set(block.id, choosePreferredBlock(existing, block));
  }

  return Array.from(byId.values())
    .sort(compareMemoryBlocks)
    .slice(0, CONTEXT_POLICY.tiers[tier].maxItems);
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
});

export const sanitizeIncomingContextPatch = (
  input: unknown,
  currentContext: Pick<AgentContext, "runtime">,
): SanitizedContextPatch => {
  if (!isPlainObject(input)) {
    return {};
  }

  const patch: SanitizedContextPatch = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "runtime" || key === "version" || key === "memory") {
      continue;
    }
    patch[key] = value;
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

    memoryPatch[tier] = sanitizeTierBlocks(rawTierValue, tier, currentContext.runtime.round);
    hasMemoryPatch = true;
  }

  if (hasMemoryPatch) {
    patch.memory = memoryPatch;
  }

  return patch;
};

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

export const compactContextMemory = (context: AgentContext): AgentContext => {
  const next = structuredClone(context) as AgentContext;
  const rawContext = context as Record<string, unknown>;
  const rawMemory = isPlainObject(rawContext.memory) ? rawContext.memory : {};
  const currentRound = context.runtime.round;

  next.memory = createEmptyMemory();

  for (const tier of CONTEXT_MEMORY_TIERS) {
    next.memory[tier] = sanitizeTierBlocks(rawMemory[tier], tier, currentRound);
  }

  next.runtime = structuredClone(context.runtime);
  next.version = context.version;
  return next;
};

export const __contextSanitizerInternals = {
  sanitizeTierBlocks,
  normalizeMemoryBlock,
  isPlainObject,
};

