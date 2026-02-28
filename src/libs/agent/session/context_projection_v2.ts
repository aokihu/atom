import type {
  AgentContext,
  AgentContextProjectionSnapshot,
  ContextProjectionDebug,
  ModelContextV2,
} from "../../../types/agent";
import type { AgentContextLiteResponse } from "../../../types/http";
import { toModelContextV2 } from "./context_model_v2";

const toJsonSizeBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
};

export const buildContextLiteMeta = (args: {
  context: AgentContext;
  modelContext: ModelContextV2;
  projectionDebug: ContextProjectionDebug;
}): AgentContextLiteResponse["meta"] => ({
  rawContextBytes: toJsonSizeBytes(args.context),
  modelContextBytes: toJsonSizeBytes(args.modelContext),
  projectionDebug: structuredClone(args.projectionDebug),
});

export const buildContextLiteResponse = (args: {
  context: AgentContext;
  modelContext?: ModelContextV2;
  projectionDebug: ContextProjectionDebug;
}): AgentContextLiteResponse => {
  const modelContext = args.modelContext ?? toModelContextV2(args.context);
  return {
    modelContext,
    meta: buildContextLiteMeta({
      context: args.context,
      modelContext,
      projectionDebug: args.projectionDebug,
    }),
  };
};

export const buildContextLiteResponseFromProjection = (
  snapshot: AgentContextProjectionSnapshot,
): AgentContextLiteResponse =>
  buildContextLiteResponse({
    context: snapshot.context,
    modelContext: snapshot.modelContext,
    projectionDebug: snapshot.projectionDebug,
  });
