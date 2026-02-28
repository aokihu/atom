import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_EXECUTION_CONFIG } from "../../../types/agent";
import { planContextBudget } from "./context_budget";
import type { AgentContext } from "../../../types/agent";

const createContext = (): AgentContext => ({
  version: 3,
  runtime: {
    round: 2,
    workspace: "/tmp/ws/",
    datetime: "2026-02-28T07:20:41.382Z",
    startup_at: 1,
  },
  memory: {
    core: [],
    working: [],
    ephemeral: [],
    longterm: [],
  },
});

describe("context_budget", () => {
  test("returns non-stop plan for small payload", () => {
    const plan = planContextBudget({
      baseMessages: [],
      context: createContext(),
      userInput: "hello",
      executionBudget: DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget,
      contextWindowTokens: 131072,
      requestedOutputTokens: 2048,
    });

    expect(plan.stop).toBe(false);
    expect(plan.budget.input_budget).toBeGreaterThan(0);
    expect(plan.budget.degrade_stage).toBeDefined();
  });

  test("returns exhausted stop when input is huge", () => {
    const huge = "x".repeat(2_500_000);
    const plan = planContextBudget({
      baseMessages: [],
      context: createContext(),
      userInput: huge,
      executionBudget: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget,
        contextWindowTokens: 4096,
        reserveOutputTokensMax: 1024,
        safetyMarginMinTokens: 600,
        outputStepDownTokens: [1024, 512],
      },
      contextWindowTokens: 4096,
      requestedOutputTokens: 1024,
    });

    expect(plan.stop).toBe(true);
    expect(plan.stopReason).toBe("context_budget_exhausted");
    expect(plan.budget.degrade_stage).toBe("exhausted");
  });
});
