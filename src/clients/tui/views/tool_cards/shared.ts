import { Box, BoxRenderable, Text, TextRenderable, instantiate } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import type { ToolDisplayEnvelope } from "../../../../types/http";
import type { TuiTheme } from "../../theme";
import type { ToolCardStyledLine } from "../tool_templates";

export type MessagePaneLegacyCompatColors = {
  nord0: string;
  nord1: string;
  nord2: string;
  nord3: string;
  nord4: string;
  nord5: string;
  nord6: string;
  nord8: string;
  nord9: string;
  nord11: string;
  nord14: string;
};

export const getMessagePaneCompatColors = (theme: TuiTheme): MessagePaneLegacyCompatColors => {
  const C = theme.colors;
  return {
    nord0: C.panelBackground,
    nord1: C.panelBackgroundAlt,
    nord2: C.panelHeaderBackground,
    nord3: C.textMuted,
    nord4: C.textSecondary,
    nord5: C.inputText,
    nord6: C.textPrimary,
    nord8: C.accentPrimary,
    nord9: C.accentSecondary,
    nord11: C.statusError,
    nord14: C.statusSuccess,
  };
};

export const mountBox = (
  renderer: CliRenderer,
  options: ConstructorParameters<typeof BoxRenderable>[1],
): BoxRenderable => instantiate(renderer, Box(options)) as unknown as BoxRenderable;

export const mountText = (
  renderer: CliRenderer,
  options: ConstructorParameters<typeof TextRenderable>[1],
): TextRenderable => instantiate(renderer, Text(options)) as unknown as TextRenderable;

export const getToolStatusColor = (
  theme: TuiTheme,
  status: "running" | "done" | "error",
): string => {
  const NORD = getMessagePaneCompatColors(theme);
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord14;
};

export const getToolCollapsedSummaryColor = (
  theme: TuiTheme,
  status: "running" | "done" | "error",
): string => {
  const NORD = getMessagePaneCompatColors(theme);
  if (status === "error") return NORD.nord11;
  return NORD.nord4;
};

export const getToolLineTextColor = (theme: TuiTheme, line: ToolCardStyledLine): string => {
  const NORD = getMessagePaneCompatColors(theme);
  if (line.kind === "summary") {
    switch (line.tone) {
      case "running":
        return NORD.nord8;
      case "success":
        return NORD.nord14;
      case "error":
        return NORD.nord11;
      case "muted":
        return NORD.nord3;
      default:
        return NORD.nord6;
    }
  }

  if (line.kind === "previewHeader") {
    return NORD.nord9;
  }

  if (line.kind === "previewLine") {
    switch (line.tone) {
      case "stderr":
      case "error":
        return NORD.nord11;
      case "stdout":
        return NORD.nord14;
      case "meta":
        return NORD.nord9;
      case "muted":
        return NORD.nord3;
      default:
        return NORD.nord4;
    }
  }

  return NORD.nord6;
};

type ToolDisplayField = {
  label: string;
  value: string;
};

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getStringValue = (value: unknown, key: string): string | undefined => {
  if (!isRecordValue(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
};

export const getToolDisplayFields = (display?: ToolDisplayEnvelope): ToolDisplayField[] => {
  if (!isRecordValue(display?.data)) return [];
  const fieldsRaw = display.data.fields;
  if (!Array.isArray(fieldsRaw)) return [];

  const fields: ToolDisplayField[] = [];
  for (const rawField of fieldsRaw) {
    if (!isRecordValue(rawField)) continue;
    const label = getStringValue(rawField, "label");
    const value = getStringValue(rawField, "value");
    if (!label || value === undefined) continue;
    fields.push({ label, value });
  }
  return fields;
};

const getToolDisplayFieldValue = (fields: ToolDisplayField[], label: string): string | undefined =>
  fields.find((field) => field.label === label)?.value;

export const getToolDisplayFieldValueFromItem = (
  item: { callDisplay?: ToolDisplayEnvelope; resultDisplay?: ToolDisplayEnvelope },
  label: string,
): string | undefined => {
  const resultFields = getToolDisplayFields(item.resultDisplay);
  const callFields = getToolDisplayFields(item.callDisplay);
  return getToolDisplayFieldValue(resultFields, label) ?? getToolDisplayFieldValue(callFields, label);
};

export const stringifyToolStyledLine = (line: ToolCardStyledLine): string => {
  if (line.kind === "spacer") return "";
  if (line.kind === "field") return `${line.label}: ${line.value}`;
  return line.text;
};
