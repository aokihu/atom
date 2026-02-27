import { summarizeOutputValue } from "../core/output_messages";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getTrimmedText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const getTextFromContentArray = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    const text =
      getTrimmedText(item) ??
      (isRecord(item) ? getTrimmedText(item.text) : undefined);
    if (text) {
      parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n");
};

export const getToolErrorMessageFromOutput = (result: unknown): string | undefined => {
  if (!isRecord(result)) return undefined;

  const error = result.error;
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }

  if (error !== undefined) {
    return summarizeOutputValue(error);
  }

  const failureByIsError = result.isError === true;
  const failureByOk = result.ok === false;
  const failureBySuccess = result.success === false;
  if (!failureByIsError && !failureByOk && !failureBySuccess) {
    return undefined;
  }

  const fallbackText =
    getTrimmedText(result.message) ??
    getTrimmedText(result.text) ??
    getTextFromContentArray(result.content);
  if (fallbackText) {
    return fallbackText;
  }

  if (failureByIsError) {
    return "Tool returned isError=true";
  }
  if (failureByOk) {
    return "Tool returned ok=false";
  }
  if (failureBySuccess) {
    return "Tool returned success=false";
  }

  return undefined;
};
