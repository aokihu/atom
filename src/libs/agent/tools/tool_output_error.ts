import { summarizeOutputValue } from "../core/output_messages";

export const getToolErrorMessageFromOutput = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;

  const error = (result as Record<string, unknown>).error;
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }

  if (error !== undefined) {
    return summarizeOutputValue(error);
  }

  return undefined;
};

