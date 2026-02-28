import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  AGENT_INTENT_GUARD_INTENT_KINDS,
  AGENT_INTENT_GUARD_TOOL_FAMILIES,
  type AgentIntentGuardIntentKind,
  type AgentIntentGuardToolFamily,
  type ResolvedAgentIntentGuardConfig,
} from "../../../types/agent";
import type { TaskExecutionStopReason } from "../../../types/task";

export type TaskIntentKind = AgentIntentGuardIntentKind;

export type TaskIntent = {
  kind: TaskIntentKind;
  confidence: number;
  source: "heuristic" | "model";
  reason: string;
};

export type ToolIntentFamily = AgentIntentGuardToolFamily;

export type TaskIntentGuardDecision =
  | { allow: true }
  | { allow: false; reason: string; stopReason: TaskExecutionStopReason };

export type TaskIntentGuardState = {
  intent: TaskIntent;
  policyEnabled: boolean;
  availableFamilyCounts: Record<ToolIntentFamily, number>;
  softAttempts: number;
  requiredSuccessFamilies: ToolIntentFamily[];
  successfulRequiredFamilyHits: number;
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
  /访问网站/,
  /打开网站/,
  /打开网页/,
  /浏览器打开/,
  /browser\s*(open|visit|navigate|access)?/i,
  /visit\s+(?:the\s+)?(?:website|webpage|url)/i,
  /navigate\s+to\s+https?:\/\//i,
  /打开(?:网页|网站)/,
  /访问(?:网页|网站)/,
];

const MEMORY_TASK_PATTERNS = [
  /记住/,
  /记忆/,
  /回忆/,
  /召回/,
  /\bmemory\b/i,
  /tag_ref/i,
  /memory_(write|search|get|update|delete|feedback|tag_resolve|compact|list_recent)/i,
];

const CODE_EDIT_TASK_PATTERNS = [
  /重构/,
  /修复/,
  /实现/,
  /写代码/,
  /改代码/,
  /\b(refactor|implement|fix|patch|code)\b/i,
];

const FILESYSTEM_TASK_PATTERNS = [
  /读取文件/,
  /查看文件/,
  /列出目录/,
  /目录结构/,
  /\b(ls|tree|ripgrep|grep|read file)\b/i,
];

const NETWORK_RESEARCH_TASK_PATTERNS = [
  /联网/,
  /上网/,
  /搜索/,
  /查一下/,
  /最新/,
  /\b(search|lookup|research|latest|news)\b/i,
];

const TOOL_FAMILY_PATTERNS: Record<ToolIntentFamily, RegExp[]> = {
  browser: [
    /browser/i,
    /playwright/i,
    /puppeteer/i,
    /selenium/i,
    /chrom(e|ium)/i,
    /webdriver/i,
  ],
  network: [
    /webfetch/i,
    /\bfetch\b/i,
    /\bhttp(s)?\b/i,
    /\burl\b/i,
    /\bpage\b/i,
    /\bcrawl\b/i,
  ],
  filesystem: [
    /^read$/,
    /^write$/,
    /^ls$/,
    /^tree$/,
    /^ripgrep$/,
    /^cp$/,
    /^mv$/,
  ],
  memory: [
    /^memory_/,
    /\bmemory\b/i,
  ],
  vcs: [
    /^git$/,
    /(^|[_:])git($|[_:])/i,
  ],
  task: [
    /^todo_/,
    /\btodo\b/i,
  ],
  shell: [
    /^bash$/,
    /^background$/,
    /\bshell\b/i,
    /\bterminal\b/i,
  ],
  unknown: [],
};

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const normalizeLabel = (value: string): TaskIntentKind | null => {
  const normalized = value.trim().toLowerCase();
  if ((AGENT_INTENT_GUARD_INTENT_KINDS as readonly string[]).includes(normalized)) {
    return normalized as TaskIntentKind;
  }
  return null;
};

const matchAnyPattern = (value: string, patterns: readonly RegExp[]) =>
  patterns.some((pattern) => pattern.test(value));

const detectHeuristicIntent = (question: string): TaskIntent => {
  const normalizedQuestion = question.trim();
  const hasMemoryVerb = /(^|[\s，。,.;；:：])(请)?记住|记下|牢记|保存到记忆|记到记忆/.test(normalizedQuestion);
  const hasPolicyLanguage = /默认|规则|以后|下次|优先|策略|失败后|当.+时|如果.+则/.test(normalizedQuestion);
  const mentionsBrowser = /浏览器|browser|playwright|puppeteer|selenium|chrom(e|ium)?/i.test(normalizedQuestion);
  const mentionsWebTarget = /网站|网页|url|http|https|www|打开|访问/i.test(normalizedQuestion);
  const hasImmediateBrowserAction = mentionsBrowser && mentionsWebTarget;

  // Memory directives should stay in memory_ops, especially preference/rule sentences.
  if (hasMemoryVerb && (hasPolicyLanguage || !hasImmediateBrowserAction)) {
    return {
      kind: "memory_ops",
      confidence: 0.97,
      source: "heuristic",
      reason: "matched_memory_directive",
    };
  }

  if (mentionsBrowser && mentionsWebTarget) {
    return {
      kind: "browser_access",
      confidence: 0.99,
      source: "heuristic",
      reason: "matched_browser_and_web_target",
    };
  }

  if (matchAnyPattern(normalizedQuestion, BROWSER_TASK_PATTERNS)) {
    return {
      kind: "browser_access",
      confidence: 0.98,
      source: "heuristic",
      reason: "matched_browser_phrase",
    };
  }

  if (matchAnyPattern(normalizedQuestion, MEMORY_TASK_PATTERNS)) {
    return {
      kind: "memory_ops",
      confidence: 0.88,
      source: "heuristic",
      reason: "matched_memory_phrase",
    };
  }

  if (matchAnyPattern(normalizedQuestion, CODE_EDIT_TASK_PATTERNS)) {
    return {
      kind: "code_edit",
      confidence: 0.82,
      source: "heuristic",
      reason: "matched_code_phrase",
    };
  }

  if (matchAnyPattern(normalizedQuestion, FILESYSTEM_TASK_PATTERNS)) {
    return {
      kind: "filesystem_ops",
      confidence: 0.8,
      source: "heuristic",
      reason: "matched_filesystem_phrase",
    };
  }

  if (matchAnyPattern(normalizedQuestion, NETWORK_RESEARCH_TASK_PATTERNS)) {
    return {
      kind: "network_research",
      confidence: 0.76,
      source: "heuristic",
      reason: "matched_network_phrase",
    };
  }

  return {
    kind: "general",
    confidence: 0.6,
    source: "heuristic",
    reason: "no_specific_phrase_matched",
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
      maxOutputTokens: 120,
      prompt: [
        "Classify the user task intent with strict JSON only.",
        `Return: {"label":"${AGENT_INTENT_GUARD_INTENT_KINDS.join("|")}","confidence":0..1,"reason":"short"}`,
        "Prefer browser_access only when browser-driven website interaction is explicitly required.",
        "Prefer general when intent is unclear.",
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

const classifyToolIntentFamily = (toolName: string): ToolIntentFamily => {
  for (const family of AGENT_INTENT_GUARD_TOOL_FAMILIES) {
    if (family === "unknown") continue;
    if (matchAnyPattern(toolName, TOOL_FAMILY_PATTERNS[family])) {
      return family;
    }
  }
  return "unknown";
};

const createFamilyCounter = (): Record<ToolIntentFamily, number> =>
  AGENT_INTENT_GUARD_TOOL_FAMILIES.reduce<Record<ToolIntentFamily, number>>((acc, family) => {
    acc[family] = 0;
    return acc;
  }, {} as Record<ToolIntentFamily, number>);

export const createTaskIntentGuard = (args: {
  intent: TaskIntent;
  config: ResolvedAgentIntentGuardConfig;
  availableToolNames: string[];
}): TaskIntentGuard => {
  const policy = args.config.intents[args.intent.kind];
  const policyEnabled = args.config.enabled && policy.enabled;
  const availableFamilyCounts = createFamilyCounter();

  for (const toolName of args.availableToolNames) {
    const family = classifyToolIntentFamily(toolName);
    availableFamilyCounts[family] += 1;
  }

  const requiredSuccessFamilies = [...policy.requiredSuccessFamilies];
  const successfulRequiredFamilyHits = createFamilyCounter();
  const attemptedRequiredFamilyHits = createFamilyCounter();
  let softAttempts = 0;

  const isAnyFamilyAvailable = (families: ToolIntentFamily[]) =>
    families.some((family) => availableFamilyCounts[family] > 0);

  const getPreflightFailure = () => {
    if (!policyEnabled) return null;
    if (!policy.noFallback) return null;

    const requiredFamilies =
      requiredSuccessFamilies.length > 0
        ? requiredSuccessFamilies
        : policy.allowedFamilies;
    if (requiredFamilies.length === 0) return null;
    if (isAnyFamilyAvailable(requiredFamilies)) return null;

    return {
      stopReason: "intent_execution_failed" as const,
      message: `No tool family available for intent "${args.intent.kind}" (required: ${requiredFamilies.join(", ")}).`,
    };
  };

  const beforeToolExecution = (toolName: string): TaskIntentGuardDecision => {
    if (!policyEnabled) {
      return { allow: true };
    }

    const family = classifyToolIntentFamily(toolName);
    if (policy.allowedFamilies.includes(family)) {
      if (requiredSuccessFamilies.includes(family)) {
        attemptedRequiredFamilyHits[family] += 1;
      }
      return { allow: true };
    }

    if (policy.softAllowedFamilies.includes(family)) {
      const attemptedRequiredTotal = requiredSuccessFamilies.reduce(
        (sum, requiredFamily) => sum + attemptedRequiredFamilyHits[requiredFamily],
        0,
      );
      const successfulRequiredTotal = requiredSuccessFamilies.reduce(
        (sum, requiredFamily) => sum + successfulRequiredFamilyHits[requiredFamily],
        0,
      );

      if (
        policy.minRequiredAttemptsBeforeSoftFallback > 0 &&
        attemptedRequiredTotal < policy.minRequiredAttemptsBeforeSoftFallback
      ) {
        return {
          allow: false,
          stopReason: "tool_policy_blocked",
          reason:
            `Intent "${args.intent.kind}" requires at least ` +
            `${policy.minRequiredAttemptsBeforeSoftFallback} attempt(s) on ` +
            `${requiredSuccessFamilies.join(", ")} before soft fallback. ` +
            `Current attempts: ${attemptedRequiredTotal}.`,
        };
      }

      if (
        policy.softFallbackOnlyOnRequiredFailure &&
        requiredSuccessFamilies.length > 0 &&
        successfulRequiredTotal > 0
      ) {
        return {
          allow: false,
          stopReason: "tool_policy_blocked",
          reason:
            `Intent "${args.intent.kind}" allows soft fallback only when ` +
            `required families fail. Current successful required hits: ${successfulRequiredTotal}.`,
        };
      }

      softAttempts += 1;
      if (softAttempts <= policy.softBlockAfter) {
        return { allow: true };
      }
      return {
        allow: false,
        stopReason: "tool_policy_blocked",
        reason:
          `Intent "${args.intent.kind}" drifted to soft-allowed family "${family}" too many times ` +
          `(${softAttempts}/${policy.softBlockAfter}).`,
      };
    }

    return {
      allow: false,
      stopReason: "tool_policy_blocked",
      reason: `Tool family "${family}" is out of scope for intent "${args.intent.kind}".`,
    };
  };

  const onToolSettled = (event: { toolName: string; ok: boolean }) => {
    if (!policyEnabled || !event.ok) return;
    const family = classifyToolIntentFamily(event.toolName);
    if (requiredSuccessFamilies.includes(family)) {
      successfulRequiredFamilyHits[family] += 1;
    }
  };

  const getCompletionFailure = () => {
    if (!policyEnabled) return null;
    if (!policy.failTaskIfUnmet) return null;
    if (requiredSuccessFamilies.length === 0) return null;

    const hit = requiredSuccessFamilies.some((family) => successfulRequiredFamilyHits[family] > 0);
    if (hit) return null;

    return {
      stopReason: "intent_execution_failed" as const,
      message:
        `Intent "${args.intent.kind}" requires successful tool execution in family: ` +
        `${requiredSuccessFamilies.join(", ")}, but none succeeded.`,
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
      policyEnabled,
      availableFamilyCounts,
      softAttempts,
      requiredSuccessFamilies,
      successfulRequiredFamilyHits: requiredSuccessFamilies.reduce(
        (sum, family) => sum + successfulRequiredFamilyHits[family],
        0,
      ),
    }),
  };
};

export const __intentGuardInternals = {
  detectHeuristicIntent,
  parseIntentResponseFromText,
  classifyToolIntentFamily,
};
