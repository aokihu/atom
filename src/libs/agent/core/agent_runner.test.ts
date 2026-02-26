import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_EXECUTION_CONFIG } from "../../../types/agent";
import { __agentRunnerInternals } from "./agent_runner";

describe("agent_runner internals", () => {
  test("classifies non-limit segment as completed", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "stop",
      segmentStepCount: 3,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerRun: 10,
      },
      totalModelSteps: 3,
      continuationRuns: 0,
    });

    expect(result).toEqual({ kind: "completed" });
  });

  test("classifies per-run step limit as auto_continue when continuation budget remains", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "length",
      segmentStepCount: 10,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerRun: 10,
        autoContinueOnStepLimit: true,
        maxContinuationRuns: 5,
      },
      totalModelSteps: 10,
      continuationRuns: 0,
    });

    expect(result).toEqual({ kind: "auto_continue" });
  });

  test("classifies continuation budget exhaustion as controlled stop", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "length",
      segmentStepCount: 10,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerRun: 10,
        autoContinueOnStepLimit: true,
        maxContinuationRuns: 1,
      },
      totalModelSteps: 20,
      continuationRuns: 1,
    });

    expect(result).toEqual({
      kind: "stop",
      stopReason: "continuation_limit_reached",
    });
  });

  test("prioritizes total model step budget exhaustion before completion classification", () => {
    const result = __agentRunnerInternals.classifySegmentOutcome({
      finishReason: "stop",
      segmentStepCount: 2,
      config: {
        ...DEFAULT_AGENT_EXECUTION_CONFIG,
        maxModelStepsPerTask: 20,
        maxModelStepsPerRun: 10,
      },
      totalModelSteps: 20,
      continuationRuns: 0,
    });

    expect(result).toEqual({
      kind: "stop",
      stopReason: "model_step_budget_exhausted",
    });
  });
});
