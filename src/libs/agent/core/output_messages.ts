import type { TaskOutputMessageDraft } from "../../../types/http";

export type AgentOutputMessageSink = (message: TaskOutputMessageDraft) => void;

const DEFAULT_SUMMARY_LIMIT = 320;

export const truncateOutputText = (
  text: string,
  maxLength = DEFAULT_SUMMARY_LIMIT,
): string => {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
};

export const summarizeOutputValue = (
  value: unknown,
  maxLength = DEFAULT_SUMMARY_LIMIT,
): string => {
  let serialized = "";

  if (typeof value === "string") {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }
  }

  const normalized = serialized.replace(/\s+/g, " ").trim();
  return truncateOutputText(normalized, maxLength);
};

export const toOutputErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const emitOutputMessage = (
  sink: AgentOutputMessageSink | undefined,
  message: TaskOutputMessageDraft,
): void => {
  if (!sink) return;

  try {
    sink(message);
  } catch {
    // Do not let observability hooks break agent execution.
  }
};
