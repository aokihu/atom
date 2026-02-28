import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_EXECUTION_CONFIG, type ContextMemoryBlock } from "../../../types/agent";
import { AgentSession } from "../session/agent_session";
import { ContextBudgetOrchestrator } from "./context_budget";

const createSession = () =>
  new AgentSession({
    workspace: "/tmp/atom-context-budget",
    systemPrompt: "system",
  });

const createMemoryBlock = (id: string, content: string, round = 1): ContextMemoryBlock => ({
  id,
  type: "note",
  decay: 0.2,
  confidence: 0.9,
  round,
  tags: ["budget"],
  content,
});

describe("context budget orchestrator", () => {
  test("trims memory tiers before model execution when context grows too large", () => {
    const session = createSession();
    session.mergeSystemContextPatch({
      memory: {
        core: [],
        working: [],
        ephemeral: Array.from({ length: 24 }, (_, index) =>
          createMemoryBlock(`e-${index}`, `ephemeral-${index} ${"x".repeat(400)}`)),
        longterm: [],
      },
    });
    session.prepareUserTurn("short question");

    const orchestrator = new ContextBudgetOrchestrator({
      ...DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget,
      contextWindowTokens: 1800,
      reserveOutputTokensCap: 1024,
      safetyMarginMinTokens: 300,
      outputTokenDownshifts: [1024, 512],
      minMemoryItems: {
        core: 0,
        working: 0,
        ephemeral: 0,
        longterm: 0,
      },
      memoryTrimStep: 4,
    });

    const result = orchestrator.apply({
      session,
      question: "short question",
      modelParams: { maxOutputTokens: 512 },
    });

    expect(result.exhausted).toBe(false);
    expect(result.budget.degrade_stage).toContain("trim_memory_");
    expect(session.getContextSnapshot().memory.ephemeral.length).toBeLessThan(24);
  });

  test("downshifts maxOutputTokens when lowering output reserve can satisfy budget", () => {
    const session = createSession();
    const question = `q ${"A".repeat(2800)}`;
    session.prepareUserTurn(question);

    const orchestrator = new ContextBudgetOrchestrator({
      ...DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget,
      contextWindowTokens: 2600,
      reserveOutputTokensCap: 2048,
      safetyMarginRatio: 0.1,
      safetyMarginMinTokens: 400,
      outputTokenDownshifts: [2048, 1024, 512],
    });

    const result = orchestrator.apply({
      session,
      question,
      modelParams: { maxOutputTokens: 4096 },
    });

    expect(result.exhausted).toBe(false);
    expect(result.modelParams?.maxOutputTokens).toBeLessThanOrEqual(1024);
    expect(result.budget.degrade_stage).toContain("downshift_output_");
  });

  test("returns exhausted when all degradations cannot fit budget", () => {
    const session = createSession();
    const question = `very long ${"Z".repeat(20_000)}`;
    session.prepareUserTurn(question);

    const orchestrator = new ContextBudgetOrchestrator({
      ...DEFAULT_AGENT_EXECUTION_CONFIG.contextBudget,
      contextWindowTokens: 1400,
      reserveOutputTokensCap: 1024,
      safetyMarginRatio: 0.2,
      safetyMarginMinTokens: 400,
      outputTokenDownshifts: [1024, 512],
      secondaryCompressTargetTokens: 1024,
    });

    const result = orchestrator.apply({
      session,
      question,
      modelParams: { maxOutputTokens: 1024 },
    });

    expect(result.exhausted).toBe(true);
    expect(result.budget.degrade_stage).toBe("context_budget_exhausted");
  });
});
