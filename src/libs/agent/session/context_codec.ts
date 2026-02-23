import { encode } from "@toon-format/toon";
import type { AgentContext } from "../../../types/agent";

export const CONTEXT_TAG_START = "<context>";
export const CONTEXT_TAG_END = "</context>";

export const encodeContextPayload = (context: AgentContext): string => encode(context);

export const buildContextBlock = (context: AgentContext): string =>
  [CONTEXT_TAG_START, encodeContextPayload(context), CONTEXT_TAG_END].join("\n");

