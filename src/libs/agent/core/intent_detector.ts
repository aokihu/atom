import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { AgentIntentDetectorMode } from "../../../types/agent";

export type DetectedIntent = {
  label: "normal" | "destructive" | "exfiltration" | "unknown";
  confidence: number;
  source: "heuristic" | "model" | "fallback";
};

const DESTRUCTIVE_PATTERN = /(rm\s+-rf|delete\s+all|drop\s+database|format\s+disk|wipe\s+all)/i;
const EXFILTRATION_PATTERN = /(leak|exfiltrate|export\s+all\s+secrets|dump\s+credentials|steal\s+token)/i;

export const detectTaskIntentHeuristic = (input: string): DetectedIntent => {
  if (DESTRUCTIVE_PATTERN.test(input)) {
    return { label: "destructive", confidence: 0.94, source: "heuristic" };
  }
  if (EXFILTRATION_PATTERN.test(input)) {
    return { label: "exfiltration", confidence: 0.94, source: "heuristic" };
  }

  if (input.trim().length === 0) {
    return { label: "unknown", confidence: 0.4, source: "heuristic" };
  }

  return { label: "normal", confidence: 0.85, source: "heuristic" };
};

const normalizeDetectedIntent = (raw: unknown): DetectedIntent | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const label = typeof value.label === "string" ? value.label : "";
  const confidenceRaw = typeof value.confidence === "number" ? value.confidence : Number(value.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5;

  if (label === "normal" || label === "destructive" || label === "exfiltration" || label === "unknown") {
    return {
      label,
      confidence,
      source: "model",
    };
  }

  return null;
};

const detectTaskIntentByModel = async (args: {
  model: LanguageModelV3;
  input: string;
  timeoutMs: number;
  modelMaxOutputTokens: number;
}): Promise<DetectedIntent> => {
  const timeoutMs = Math.max(1, Math.floor(args.timeoutMs));
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort("intent-timeout"), timeoutMs);

  try {
    const result = await generateText({
      model: args.model,
      abortSignal: abortController.signal,
      temperature: 0,
      maxOutputTokens: Math.max(16, Math.floor(args.modelMaxOutputTokens)),
      prompt: [
        "Classify user intent for runtime policy.",
        "Return JSON only with fields: label(normal|destructive|exfiltration|unknown), confidence(0..1).",
        "Input:",
        args.input,
      ].join("\n"),
    });

    const parsed = normalizeDetectedIntent(JSON.parse(result.text));
    if (!parsed) {
      return { label: "unknown", confidence: 0.5, source: "fallback" };
    }

    return parsed;
  } finally {
    clearTimeout(timer);
  }
};

export const detectTaskIntent = async (args: {
  model: LanguageModelV3;
  input: string;
  mode: AgentIntentDetectorMode;
  timeoutMs: number;
  modelMaxOutputTokens: number;
}): Promise<DetectedIntent> => {
  const heuristic = detectTaskIntentHeuristic(args.input);
  if (args.mode === "heuristic") {
    return heuristic;
  }

  if (heuristic.confidence >= 0.92) {
    return heuristic;
  }

  if (args.mode === "model" || args.mode === "hybrid") {
    try {
      return await detectTaskIntentByModel({
        model: args.model,
        input: args.input,
        timeoutMs: args.timeoutMs,
        modelMaxOutputTokens: args.modelMaxOutputTokens,
      });
    } catch {
      return {
        ...heuristic,
        source: "fallback",
      };
    }
  }

  return heuristic;
};
