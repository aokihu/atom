import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ResolvedAgentIntentGuardConfig } from "../../../types/agent";
import type { TaskExecutionStopReason } from "../../../types/task";

export type TaskIntentKind = "general" | "browser_access";

export type TaskIntent = {
  kind: TaskIntentKind;
  confidence: number;
  source: "heuristic" | "model";
  reason: string;
};

export type ToolIntentScope = "browser" | "network_adjacent" | "out_of_scope";

export type TaskIntentGuardDecision =
  | { allow: true }
  | { allow: false; reason: string; stopReason: TaskExecutionStopReason };

export type TaskIntentGuardState = {
  intent: TaskIntent;
  browserToolAvailable: boolean;
  adjacentAttempts: number;
  successfulBrowserCalls: number;
};

export type TaskIntentGuard = {
  readonly intent: TaskIntent;
  beforeToolExecution: (toolName: string) => TaskIntentGuardDecision;
  onToolSettled: (event: { toolName: string; ok: boolean }) => void;
  getPreflightFailure: () => { stopReason: TaskExecutionStopReason; message: string } | null;
  getCompletionFailure: () => { stopReason: TaskExecutionStopReason; message: string } | null;
  getState: () => TaskIntentGuardState;
};

const BROWSER_TASK_PATTERNS = [
  /用浏览器/,
  /浏览器访问/,
  /browser\s*(open|visit|navigate|access)?/i,
  /visit\s+(?:the\s+)?(?:website|webpage|url)/i,
  /navigate\s+to\s+https?:\/\//i,
  /打开(?:网页|网站)/,
  /访问(?:网页|网站)/,
];

const BROWSER_TOOL_PATTERNS = [
  /browser/i,
  /playwright/i,
  /puppeteer/i,
  /selenium/i,
  /chrom(e|ium)/i,
  /webdriver/i,
];

const NETWORK_ADJACENT_TOOL_PATTERNS = [
  ...BROWSER_TOOL_PATTERNS,
  /webfetch/i,
  /fetch/i,
  /http/i,
  /https/i,
  /navigate/i,
  /page/i,
  /url/i,
  /web/i,
];

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const normalizeLabel = (value: string): TaskIntentKind | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "browser_access") return "browser_access";
  if (normalized === "general") return "general";
  return null;
};

const matchAnyPattern = (value: string, patterns: readonly RegExp[]) =>
  patterns.some((pattern) => pattern.test(value));

const detectHeuristicIntent = (question: string): TaskIntent => {
  const normalizedQuestion = question.trim();
  if (matchAnyPattern(normalizedQuestion, BROWSER_TASK_PATTERNS)) {
    return {
      kind: "browser_access",
      confidence: 0.98,
      source: "heuristic",
      reason: "matched_explicit_browser_phrase",
    };
  }

  return {
    kind: "general",
    confidence: 0.6,
    source: "heuristic",
    reason: "no_browser_phrase_matched",
  };
};

const parseIntentResponseFromText = (text: string): TaskIntent | null => {
  const jsonFragment = text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonFragment) return null;

  try {
    const parsed = JSON.parse(jsonFragment) as Record<string, unknown>;
    const labelValue = typeof parsed.label === "string" ? normalizeLabel(parsed.label) : null;
    if (!labelValue) return null;

    const confidence = typeof parsed.confidence === "number"
      ? clamp01(parsed.confidence)
      : 0.5;
    const reason = typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 120)
      : "model_classification";

    return {
      kind: labelValue,
      confidence,
      source: "model",
      reason,
    };
  } catch {
    return null;
  }
};

export const detectTaskIntent = async (args: {
  model: LanguageModelV3;
  question: string;
  config: ResolvedAgentIntentGuardConfig;
  abortSignal?: AbortSignal;
}): Promise<TaskIntent> => {
  const heuristic = detectHeuristicIntent(args.question);
  if (heuristic.kind === "browser_access") {
    return heuristic;
  }

  if (args.config.detector !== "model") {
    return heuristic;
  }

  try {
    const result = await generateText({
      model: args.model,
      abortSignal: args.abortSignal,
      temperature: 0,
      maxOutputTokens: 80,
      prompt: [
        "Classify the user task intent with strict JSON only.",
        'Return: {"label":"browser_access|general","confidence":0..1,"reason":"short"}',
        "Label browser_access only when user explicitly requires browser-driven website interaction.",
        `USER_TASK: ${args.question}`,
      ].join("\n"),
    });

    const parsed = parseIntentResponseFromText(result.text);
    if (parsed) return parsed;
    return heuristic;
  } catch {
    return heuristic;
  }
};

const classifyToolIntentScope = (toolName: string): ToolIntentScope => {
  if (matchAnyPattern(toolName, BROWSER_TOOL_PATTERNS)) {
    return "browser";
  }

  if (matchAnyPattern(toolName, NETWORK_ADJACENT_TOOL_PATTERNS)) {
    return "network_adjacent";
  }

  return "out_of_scope";
};

export const createTaskIntentGuard = (args: {
  intent: TaskIntent;
  config: ResolvedAgentIntentGuardConfig;
  availableToolNames: string[];
}): TaskIntentGuard => {
  const browserToolAvailable = args.availableToolNames.some((toolName) =>
    classifyToolIntentScope(toolName) === "browser"
  );
  let adjacentAttempts = 0;
  let successfulBrowserCalls = 0;

  const getPreflightFailure = () => {
    if (args.intent.kind !== "browser_access") return null;
    if (!args.config.browser.noFallback) return null;
    if (browserToolAvailable) return null;
    return {
      stopReason: "intent_execution_failed" as const,
      message: "No browser-capable tool is available for this browser-required task.",
    };
  };

  const beforeToolExecution = (toolName: string): TaskIntentGuardDecision => {
    if (args.intent.kind !== "browser_access") {
      return { allow: true };
    }

    const scope = classifyToolIntentScope(toolName);
    if (scope === "browser") {
      return { allow: true };
    }

    if (scope === "network_adjacent" && args.config.browser.networkAdjacentOnly) {
      adjacentAttempts += 1;
      if (adjacentAttempts <= args.config.softBlockAfter) {
        return { allow: true };
      }
      return {
        allow: false,
        stopReason: "tool_policy_blocked",
        reason: `Browser task drifted to non-browser tools too many times (${adjacentAttempts}/${args.config.softBlockAfter}).`,
      };
    }

    return {
      allow: false,
      stopReason: "tool_policy_blocked",
      reason: "This task requires browser-oriented tools; non-network tools are blocked.",
    };
  };

  const onToolSettled = (event: { toolName: string; ok: boolean }) => {
    if (!event.ok) return;
    if (args.intent.kind !== "browser_access") return;
    if (classifyToolIntentScope(event.toolName) === "browser") {
      successfulBrowserCalls += 1;
    }
  };

  const getCompletionFailure = () => {
    if (args.intent.kind !== "browser_access") return null;
    if (!args.config.browser.failTaskIfUnmet) return null;
    if (successfulBrowserCalls > 0) return null;
    return {
      stopReason: "intent_execution_failed" as const,
      message: "Task requested browser access but no browser-capable tool completed successfully.",
    };
  };

  return {
    intent: args.intent,
    beforeToolExecution,
    onToolSettled,
    getPreflightFailure,
    getCompletionFailure,
    getState: () => ({
      intent: args.intent,
      browserToolAvailable,
      adjacentAttempts,
      successfulBrowserCalls,
    }),
  };
};

export const __intentGuardInternals = {
  detectHeuristicIntent,
  parseIntentResponseFromText,
  classifyToolIntentScope,
};
