import { construct, crush } from "radashi";
import type { AgentContext } from "../../../types/agent";
import { formatedDatetimeNow } from "../../utils/date";

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
  version: 2.2,
  runtime: {
    round: 1,
    workspace,
    datetime: clock.nowDatetime(),
    startup_at: clock.nowTimestamp(),
  },
});

export class AgentContextState {
  private context: AgentContext;
  private readonly clock: AgentContextClock;

  constructor(args: { workspace: string; clock?: AgentContextClock }) {
    this.clock = args.clock ?? defaultClock;
    this.context = createInitialContext(args.workspace, this.clock);
  }

  merge(context: Partial<AgentContext>) {
    const originalContext = crush(this.context);
    const targetContext = crush(context);
    const mergedContext = { ...originalContext, ...targetContext };
    this.context = construct(mergedContext) as AgentContext;
  }

  updateRuntime() {
    this.context.runtime.round += 1;
    this.context.runtime.datetime = this.clock.nowDatetime();
  }

  snapshot() {
    return structuredClone(this.context);
  }

  getCurrentContext() {
    return this.context;
  }
}

