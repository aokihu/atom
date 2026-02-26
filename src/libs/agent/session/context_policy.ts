import type { ContextMemoryBlock, ContextMemoryTier } from "../../../types/agent";

export const CONTEXT_MEMORY_TIERS: readonly ContextMemoryTier[] = [
  "core",
  "working",
  "ephemeral",
];

export type ContextTierPolicy = {
  maxDecay: number;
  minConfidence: number;
  maxItems: number;
  maxAgeRounds?: number;
};

export type RawContextRetentionPolicy = {
  tiers: Record<ContextMemoryTier, { maxItems: number }>;
  workingTerminalMaxAgeRounds: number;
  ephemeralMaxAgeRounds: number;
};

export const CONTEXT_POLICY = {
  version: 2.3,
  projectionPolicyVersion: "v2.3-projection",
  defaultConfidence: 0.5,
  contentMaxLength: 512,
  tagsMaxItems: 8,
  tagMaxLength: 32,
  tiers: {
    core: {
      maxDecay: 0.35,
      minConfidence: 0.7,
      maxItems: 24,
      maxAgeRounds: undefined,
    },
    working: {
      maxDecay: 0.65,
      minConfidence: 0.55,
      maxItems: 48,
      maxAgeRounds: 12,
    },
    ephemeral: {
      maxDecay: 0.8,
      minConfidence: 0.4,
      maxItems: 24,
      maxAgeRounds: 3,
    },
  } satisfies Record<ContextMemoryTier, ContextTierPolicy>,
  rawRetention: {
    tiers: {
      core: { maxItems: 200 },
      working: { maxItems: 500 },
      ephemeral: { maxItems: 200 },
    },
    workingTerminalMaxAgeRounds: 120,
    ephemeralMaxAgeRounds: 30,
  } satisfies RawContextRetentionPolicy,
} as const;

export const getMemoryBlockQuality = (block: Pick<ContextMemoryBlock, "decay" | "confidence">) =>
  0.5 * (1 - block.decay) + 0.5 * block.confidence;
