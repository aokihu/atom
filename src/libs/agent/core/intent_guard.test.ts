import { describe, expect, test } from "bun:test";
import {
  __intentGuardInternals,
  createTaskIntentGuard,
} from "./intent_guard";
import type { ResolvedAgentIntentGuardConfig } from "../../../types/agent";

const DEFAULT_GUARD_CONFIG: ResolvedAgentIntentGuardConfig = {
  enabled: true,
  detector: "model",
  softBlockAfter: 2,
  browser: {
    noFallback: true,
    networkAdjacentOnly: true,
    failTaskIfUnmet: true,
  },
};

describe("intent_guard", () => {
  test("heuristic detects explicit browser task", () => {
    const intent = __intentGuardInternals.detectHeuristicIntent("请用浏览器访问 www.19lou.com");
    expect(intent.kind).toBe("browser_access");
    expect(intent.source).toBe("heuristic");
  });

  test("preflight fails when browser task has no browser-capable tool", () => {
    const guard = createTaskIntentGuard({
      intent: {
        kind: "browser_access",
        confidence: 0.9,
        source: "heuristic",
        reason: "test",
      },
      config: DEFAULT_GUARD_CONFIG,
      availableToolNames: ["webfetch", "read"],
    });

    const preflight = guard.getPreflightFailure();
    expect(preflight?.stopReason).toBe("intent_execution_failed");
  });

  test("soft-blocks repeated non-browser network-adjacent attempts", () => {
    const guard = createTaskIntentGuard({
      intent: {
        kind: "browser_access",
        confidence: 0.9,
        source: "heuristic",
        reason: "test",
      },
      config: {
        ...DEFAULT_GUARD_CONFIG,
        softBlockAfter: 2,
      },
      availableToolNames: ["playwright_browser_navigate", "webfetch"],
    });

    expect(guard.beforeToolExecution("webfetch")).toEqual({ allow: true });
    expect(guard.beforeToolExecution("webfetch")).toEqual({ allow: true });
    const thirdAttempt = guard.beforeToolExecution("webfetch");
    expect(thirdAttempt.allow).toBe(false);
    expect(thirdAttempt.allow ? "" : thirdAttempt.stopReason).toBe("tool_policy_blocked");
  });

  test("completion fails if browser tool never succeeds", () => {
    const guard = createTaskIntentGuard({
      intent: {
        kind: "browser_access",
        confidence: 0.9,
        source: "heuristic",
        reason: "test",
      },
      config: DEFAULT_GUARD_CONFIG,
      availableToolNames: ["playwright_browser_navigate"],
    });

    guard.onToolSettled({ toolName: "playwright_browser_navigate", ok: false });
    expect(guard.getCompletionFailure()?.stopReason).toBe("intent_execution_failed");
  });

  test("completion passes after successful browser tool call", () => {
    const guard = createTaskIntentGuard({
      intent: {
        kind: "browser_access",
        confidence: 0.9,
        source: "heuristic",
        reason: "test",
      },
      config: DEFAULT_GUARD_CONFIG,
      availableToolNames: ["playwright_browser_navigate"],
    });

    guard.onToolSettled({ toolName: "playwright_browser_navigate", ok: true });
    expect(guard.getCompletionFailure()).toBeNull();
  });
});
