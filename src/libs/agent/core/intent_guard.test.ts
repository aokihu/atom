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
  intents: {
    general: {
      enabled: false,
      allowedFamilies: [],
      softAllowedFamilies: [],
      softBlockAfter: 2,
      minRequiredAttemptsBeforeSoftFallback: 0,
      softFallbackOnlyOnRequiredFailure: false,
      noFallback: false,
      failTaskIfUnmet: false,
      requiredSuccessFamilies: [],
    },
    browser_access: {
      enabled: true,
      allowedFamilies: ["browser"],
      softAllowedFamilies: ["network"],
      softBlockAfter: 2,
      minRequiredAttemptsBeforeSoftFallback: 3,
      softFallbackOnlyOnRequiredFailure: true,
      noFallback: true,
      failTaskIfUnmet: true,
      requiredSuccessFamilies: ["browser"],
    },
    network_research: {
      enabled: false,
      allowedFamilies: ["network", "browser"],
      softAllowedFamilies: [],
      softBlockAfter: 2,
      minRequiredAttemptsBeforeSoftFallback: 0,
      softFallbackOnlyOnRequiredFailure: false,
      noFallback: false,
      failTaskIfUnmet: false,
      requiredSuccessFamilies: [],
    },
    filesystem_ops: {
      enabled: false,
      allowedFamilies: ["filesystem"],
      softAllowedFamilies: ["shell"],
      softBlockAfter: 2,
      minRequiredAttemptsBeforeSoftFallback: 0,
      softFallbackOnlyOnRequiredFailure: false,
      noFallback: false,
      failTaskIfUnmet: false,
      requiredSuccessFamilies: [],
    },
    code_edit: {
      enabled: false,
      allowedFamilies: ["filesystem", "vcs"],
      softAllowedFamilies: ["shell"],
      softBlockAfter: 2,
      minRequiredAttemptsBeforeSoftFallback: 0,
      softFallbackOnlyOnRequiredFailure: false,
      noFallback: false,
      failTaskIfUnmet: false,
      requiredSuccessFamilies: [],
    },
    memory_ops: {
      enabled: false,
      allowedFamilies: ["memory"],
      softAllowedFamilies: [],
      softBlockAfter: 2,
      minRequiredAttemptsBeforeSoftFallback: 0,
      softFallbackOnlyOnRequiredFailure: false,
      noFallback: false,
      failTaskIfUnmet: false,
      requiredSuccessFamilies: [],
    },
  },
};

describe("intent_guard", () => {
  test("heuristic detects explicit browser task", () => {
    const intent = __intentGuardInternals.detectHeuristicIntent("请用浏览器访问 www.19lou.com");
    expect(intent.kind).toBe("browser_access");
    expect(intent.source).toBe("heuristic");
  });

  test("heuristic detects code edit task", () => {
    const intent = __intentGuardInternals.detectHeuristicIntent("请帮我重构这个模块并补测试");
    expect(intent.kind).toBe("code_edit");
  });

  test("heuristic treats memory-policy directive as memory intent", () => {
    const intent = __intentGuardInternals.detectHeuristicIntent(
      "记住访问网站的时候默认执行意图是使用浏览器，失败后才是用webfetch",
    );
    expect(intent.kind).toBe("memory_ops");
  });

  test("heuristic keeps browser intent for immediate execution request", () => {
    const intent = __intentGuardInternals.detectHeuristicIntent(
      "请记住这个偏好，并且现在立刻用浏览器访问 www.19lou.com",
    );
    expect(intent.kind).toBe("browser_access");
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

    // Gate opens only after minimum browser attempts.
    expect(guard.beforeToolExecution("playwright_browser_navigate")).toEqual({ allow: true });
    guard.onToolSettled({ toolName: "playwright_browser_navigate", ok: false });
    expect(guard.beforeToolExecution("playwright_browser_navigate")).toEqual({ allow: true });
    guard.onToolSettled({ toolName: "playwright_browser_navigate", ok: false });
    expect(guard.beforeToolExecution("playwright_browser_navigate")).toEqual({ allow: true });
    guard.onToolSettled({ toolName: "playwright_browser_navigate", ok: false });

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

  test("generic intent policy restricts tool families", () => {
    const guard = createTaskIntentGuard({
      intent: {
        kind: "code_edit",
        confidence: 0.86,
        source: "heuristic",
        reason: "test",
      },
      config: {
        ...DEFAULT_GUARD_CONFIG,
        intents: {
          ...DEFAULT_GUARD_CONFIG.intents,
          code_edit: {
            enabled: true,
            allowedFamilies: ["filesystem", "vcs"],
            softAllowedFamilies: ["shell"],
            softBlockAfter: 1,
            minRequiredAttemptsBeforeSoftFallback: 0,
            softFallbackOnlyOnRequiredFailure: false,
            noFallback: false,
            failTaskIfUnmet: true,
            requiredSuccessFamilies: ["filesystem"],
          },
        },
      },
      availableToolNames: ["read", "git", "bash"],
    });

    expect(guard.beforeToolExecution("read")).toEqual({ allow: true });
    expect(guard.beforeToolExecution("bash")).toEqual({ allow: true });
    const blocked = guard.beforeToolExecution("bash");
    expect(blocked.allow).toBe(false);
    expect(blocked.allow ? "" : blocked.stopReason).toBe("tool_policy_blocked");
    const blockedOutOfScope = guard.beforeToolExecution("webfetch");
    expect(blockedOutOfScope.allow).toBe(false);

    expect(guard.getCompletionFailure()?.stopReason).toBe("intent_execution_failed");
    guard.onToolSettled({ toolName: "read", ok: true });
    expect(guard.getCompletionFailure()).toBeNull();
  });

  test("browser soft fallback requires at least three browser attempts", () => {
    const guard = createTaskIntentGuard({
      intent: {
        kind: "browser_access",
        confidence: 0.9,
        source: "heuristic",
        reason: "test",
      },
      config: DEFAULT_GUARD_CONFIG,
      availableToolNames: ["browsermcp__browser_navigate", "webfetch"],
    });

    const beforeAttempts = guard.beforeToolExecution("webfetch");
    expect(beforeAttempts.allow).toBe(false);
    expect(beforeAttempts.allow ? "" : beforeAttempts.stopReason).toBe("tool_policy_blocked");

    expect(guard.beforeToolExecution("browsermcp__browser_navigate")).toEqual({ allow: true });
    guard.onToolSettled({ toolName: "browsermcp__browser_navigate", ok: false });
    expect(guard.beforeToolExecution("browsermcp__browser_navigate")).toEqual({ allow: true });
    guard.onToolSettled({ toolName: "browsermcp__browser_navigate", ok: false });
    expect(guard.beforeToolExecution("browsermcp__browser_navigate")).toEqual({ allow: true });
    guard.onToolSettled({ toolName: "browsermcp__browser_navigate", ok: false });

    expect(guard.beforeToolExecution("webfetch")).toEqual({ allow: true });
  });
});
