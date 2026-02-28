import { encode } from "@toon-format/toon";

export const CONTEXT_TAG_START = "<context>";
export const CONTEXT_TAG_END = "</context>";

export const encodeContextPayload = (context: unknown): string => encode(context);

export const buildContextBlock = (context: unknown): string =>
  [CONTEXT_TAG_START, encodeContextPayload(context), CONTEXT_TAG_END].join("\n");
