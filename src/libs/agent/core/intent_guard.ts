import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ResolvedAgentExecutionIntentGuardConfig } from "../../../types/agent";
import { detectTaskIntent, type DetectedIntent } from "./intent_detector";
import { evaluateIntentPolicy, type IntentPolicyDecision } from "./intent_policy_engine";

export type IntentGuardResult = {
  intent: DetectedIntent;
  decision: IntentPolicyDecision;
};

export const runIntentGuard = async (args: {
  model: LanguageModelV3;
  input: string;
  config: ResolvedAgentExecutionIntentGuardConfig;
}): Promise<IntentGuardResult> => {
  if (!args.config.enabled) {
    return {
      intent: {
        label: "normal",
        confidence: 1,
        source: "heuristic",
      },
      decision: {
        action: "allow",
        reason: "intent_guard_disabled",
      },
    };
  }

  const intent = await detectTaskIntent({
    model: args.model,
    input: args.input,
    mode: args.config.detector,
    timeoutMs: args.config.detectorTimeoutMs,
    modelMaxOutputTokens: args.config.detectorModelMaxOutputTokens,
  });

  return {
    intent,
    decision: evaluateIntentPolicy(intent),
  };
};
