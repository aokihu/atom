import type { AgentContext } from "../../../types/agent";
import { formatedDatetimeNow } from "../../utils/date";
import { CONTEXT_POLICY } from "./context_policy";
import {
  compactContextMemory,
  mergeContextWithMemoryPolicy,
  type SanitizedContextPatch,
} from "./context_sanitizer";

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
    this.context = compactContextMemory(mergedContext);
  }

  refreshRuntime(options?: { advanceRound?: boolean }) {
    if (options?.advanceRound ?? true) {
      this.context.runtime.round += 1;
    }
    this.context.runtime.datetime = this.clock.nowDatetime();
  }

  updateRuntime() {
    this.refreshRuntime({ advanceRound: true });
  }

  snapshot() {
    return structuredClone(this.context);
  }

  getCurrentContext() {
    return this.context;
  }
}
