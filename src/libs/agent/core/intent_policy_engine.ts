import type { DetectedIntent } from "./intent_detector";

export type IntentPolicyDecision = {
  action: "allow" | "soft_fail" | "fail";
  reason: string;
};

export const evaluateIntentPolicy = (intent: DetectedIntent): IntentPolicyDecision => {
  if (intent.label === "destructive" && intent.confidence >= 0.92) {
    return {
      action: "fail",
      reason: "high_confidence_destructive_intent",
    };
  }

  if (intent.label === "exfiltration" && intent.confidence >= 0.92) {
    return {
      action: "fail",
      reason: "high_confidence_exfiltration_intent",
    };
  }

  if (intent.label !== "normal") {
    return {
      action: "soft_fail",
      reason: "uncertain_or_risky_intent",
    };
  }

  return {
    action: "allow",
    reason: "normal_intent",
  };
};
