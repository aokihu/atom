import type {
  AgentContext,
  AgentContextProjectionSnapshot,
  AgentContextRuntime,
} from "../../../types/agent";
import { formatedDatetimeNow } from "../../utils/date";
import { CONTEXT_POLICY } from "./context_policy";
import {
  buildInjectedContextProjection,
  compactRawContextForStorage,
  mergeContextWithMemoryPolicy,
  type SanitizedContextPatch,
} from "./context_sanitizer";
import { toModelContextV2 } from "./context_model_v2";

export type AgentContextClock = {
  nowDatetime: () => string;
  nowTimestamp: () => number;
};

const defaultClock: AgentContextClock = {
  nowDatetime: () => formatedDatetimeNow(),
  nowTimestamp: () => Date.now(),
};

const createInitialContext = (
  workspace: string,
  clock: AgentContextClock,
): AgentContext => ({
  version: CONTEXT_POLICY.version,
  runtime: {
    round: 1,
    workspace,
    datetime: clock.nowDatetime(),
    startup_at: clock.nowTimestamp(),
  },
  memory: {
    core: [],
    working: [],
    ephemeral: [],
    longterm: [],
  },
  todo: {
    summary: "暂无TODO",
    total: 0,
    step: 0,
  },
});

export class AgentContextState {
  private context: AgentContext;
  private readonly clock: AgentContextClock;

  constructor(args: { workspace: string; clock?: AgentContextClock }) {
    this.clock = args.clock ?? defaultClock;
    this.context = createInitialContext(args.workspace, this.clock);
  }

  merge(context: SanitizedContextPatch) {
    const mergedContext = mergeContextWithMemoryPolicy(this.context, context);
    this.context = compactRawContextForStorage(mergedContext);
  }

  replaceMemory(memory: AgentContext["memory"]) {
    const next = structuredClone(this.context);
    next.memory = structuredClone(memory);
    this.context = compactRawContextForStorage(next);
  }

  refreshRuntime(options?: { advanceRound?: boolean }) {
    if (options?.advanceRound ?? true) {
      this.context.runtime.round += 1;
    }
    this.context.runtime.datetime = this.clock.nowDatetime();
  }

  updateRuntimeTokenUsage(tokenUsage: NonNullable<AgentContextRuntime["token_usage"]>) {
    this.context.runtime.token_usage = structuredClone(tokenUsage);
  }

  nowTimestamp() {
    return this.clock.nowTimestamp();
  }

  updateRuntime() {
    this.refreshRuntime({ advanceRound: true });
  }

  snapshot() {
    return structuredClone(this.context);
  }

  snapshotRaw() {
    return this.snapshot();
  }

  snapshotInjected() {
    return this.snapshotWithProjectionDebug().injectedContext;
  }

  snapshotWithProjectionDebug(): AgentContextProjectionSnapshot {
    const raw = this.snapshot();
    const projection = buildInjectedContextProjection(raw);
    const modelContext = toModelContextV2(projection.injectedContext);

    return {
      context: raw,
      injectedContext: projection.injectedContext,
      modelContext,
      projectionDebug: projection.debug,
    };
  }

  getCurrentContext() {
    return this.context;
  }
}
