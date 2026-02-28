import { describe, expect, test } from "bun:test";
import { detectTaskIntent, detectTaskIntentHeuristic } from "./intent_detector";
import { evaluateIntentPolicy } from "./intent_policy_engine";

describe("intent_detector", () => {
  test("heuristic detects destructive intent", () => {
    const intent = detectTaskIntentHeuristic("please rm -rf /tmp/project");
    expect(intent.label).toBe("destructive");
    expect(intent.confidence).toBeGreaterThan(0.9);
  });

  test("heuristic mode bypasses model detector", async () => {
    const intent = await detectTaskIntent({
      model: {} as any,
      input: "delete all files now",
      mode: "heuristic",
      timeoutMs: 10,
      modelMaxOutputTokens: 20,
    });

    expect(intent.label).toBe("destructive");
    expect(intent.source).toBe("heuristic");
  });

  test("policy fails high confidence exfiltration intent", () => {
    const decision = evaluateIntentPolicy({
      label: "exfiltration",
      confidence: 0.95,
      source: "heuristic",
    });

    expect(decision.action).toBe("fail");
  });
});
