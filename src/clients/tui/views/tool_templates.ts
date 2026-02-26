/**
 * TUI 视图辅助模块：Tool Templates（工具卡片模板渲染）
 * 用于何处：被 `src/clients/tui/views/message_pane.ts` 调用，用于生成工具调用/结果卡片的摘要文本与结构化展示行。
 * 主要职责：解析 `ToolDisplayEnvelope`，输出统一的工具卡片摘要、正文文本和带语义 tone 的渲染行数据。
 *
 * ASCII Layout (data pipeline, no terminal widget tree here)
 * ToolDisplayEnvelope
 *        |
 *        v
 *   parseDisplayData
 *        |
 *        +--> collapsed summary text
 *        |
 *        +--> styled lines (summary / field / preview / spacer)
 *        |
 *        +--> plain body text fallback
 */
import type { ToolDisplayEnvelope } from "../../../types/http";

type ToolCardTemplateInput = {
  toolName: string;
  status: "running" | "done" | "error";
  callSummary?: string;
  resultSummary?: string;
  errorMessage?: string;
  callDisplay?: ToolDisplayEnvelope;
  resultDisplay?: ToolDisplayEnvelope;
};

export type ToolCardLineTone =
  | "default"
  | "summary"
  | "running"
  | "success"
  | "error"
  | "warning"
  | "accent"
  | "muted"
  | "preview"
  | "previewHeader"
  | "stdout"
  | "stderr"
  | "meta";

export type ToolCardStyledLine =
  | {
      kind: "summary";
      text: string;
      tone: ToolCardLineTone;
    }
  | {
      kind: "field";
      label: string;
      value: string;
      tone: ToolCardLineTone;
    }
  | {
      kind: "previewHeader";
      text: string;
      tone: "previewHeader";
    }
  | {
      kind: "previewLine";
      text: string;
      tone: ToolCardLineTone;
    }
  | {
      kind: "spacer";
    };

type DisplayField = {
  label: string;
  value: string;
};

type DisplayPreview = {
  title?: string;
  lines: string[];
  truncated?: boolean;
};

type DisplayData = {
  summary?: string;
  fields?: DisplayField[];
  previews?: DisplayPreview[];
};

type DisplayRenderer = (display: ToolDisplayEnvelope) => string | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDisplayEnvelope = (value: unknown): value is ToolDisplayEnvelope => {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.toolName === "string" &&
    (value.phase === "call" || value.phase === "result") &&
    typeof value.templateKey === "string" &&
    isRecord(value.data)
  );
};

const parseDisplayData = (display: ToolDisplayEnvelope): DisplayData | undefined => {
  const { data } = display;
  if (!isRecord(data)) return undefined;

  const summary = typeof data.summary === "string" ? data.summary : undefined;

  const fields = Array.isArray(data.fields)
    ? data.fields
        .map((field): DisplayField | undefined => {
          if (!isRecord(field)) return undefined;
          const label = field.label;
          const value = field.value;
          if (typeof label !== "string" || typeof value !== "string") return undefined;
          return { label, value };
        })
        .filter((field): field is DisplayField => field !== undefined)
    : undefined;

  const previews = Array.isArray(data.previews)
    ? data.previews
        .map((preview): DisplayPreview | undefined => {
          if (!isRecord(preview)) return undefined;
          const title = typeof preview.title === "string" ? preview.title : undefined;
          const lines = Array.isArray(preview.lines)
            ? preview.lines.filter((line): line is string => typeof line === "string")
            : [];
          if (lines.length === 0) return undefined;
          const truncated = typeof preview.truncated === "boolean" ? preview.truncated : undefined;
          return {
            ...(title ? { title } : {}),
            lines,
            ...(truncated !== undefined ? { truncated } : {}),
          };
        })
        .filter((preview): preview is DisplayPreview => preview !== undefined)
    : undefined;

  return {
    ...(summary ? { summary } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
    ...(previews && previews.length > 0 ? { previews } : {}),
  };
};

const renderStructuredDisplay = (display: ToolDisplayEnvelope): string | undefined => {
  const styled = buildStyledLinesFromDisplay(display, "done");
  if (!styled) return undefined;
  return styled
    .map((line) => {
      if (line.kind === "spacer") return "";
      if (line.kind === "field") return `${line.label}: ${line.value}`;
      return line.text;
    })
    .join("\n");
};

const renderGenericFallback = (input: ToolCardTemplateInput): string => {
  return buildToolCardStyledLines(input)
    .map((line) => {
      if (line.kind === "spacer") return "";
      if (line.kind === "field") return `${line.label}: ${line.value}`;
      return line.text;
    })
    .join("\n");
};

const buildBuiltinRenderer = (): DisplayRenderer => renderStructuredDisplay;

const TEMPLATE_RENDERERS: Record<string, DisplayRenderer> = {
  "builtin.read.call": buildBuiltinRenderer(),
  "builtin.read.result": buildBuiltinRenderer(),
  "builtin.write.call": buildBuiltinRenderer(),
  "builtin.write.result": buildBuiltinRenderer(),
  "builtin.ls.call": buildBuiltinRenderer(),
  "builtin.ls.result": buildBuiltinRenderer(),
  "builtin.tree.call": buildBuiltinRenderer(),
  "builtin.tree.result": buildBuiltinRenderer(),
  "builtin.ripgrep.call": buildBuiltinRenderer(),
  "builtin.ripgrep.result": buildBuiltinRenderer(),
  "builtin.cp.call": buildBuiltinRenderer(),
  "builtin.cp.result": buildBuiltinRenderer(),
  "builtin.mv.call": buildBuiltinRenderer(),
  "builtin.mv.result": buildBuiltinRenderer(),
  "builtin.git.call": buildBuiltinRenderer(),
  "builtin.git.result": buildBuiltinRenderer(),
  "builtin.bash.call": buildBuiltinRenderer(),
  "builtin.bash.start.call": buildBuiltinRenderer(),
  "builtin.bash.query.call": buildBuiltinRenderer(),
  "builtin.bash.kill.call": buildBuiltinRenderer(),
  "builtin.bash.once.result": buildBuiltinRenderer(),
  "builtin.bash.session_start.result": buildBuiltinRenderer(),
  "builtin.bash.session_query.result": buildBuiltinRenderer(),
  "builtin.bash.session_kill.result": buildBuiltinRenderer(),
  "builtin.bash.error.result": buildBuiltinRenderer(),
  "builtin.webfetch.call": buildBuiltinRenderer(),
  "builtin.webfetch.result": buildBuiltinRenderer(),
};

const renderDisplayWithRegistry = (display: ToolDisplayEnvelope): string | undefined => {
  const renderer = TEMPLATE_RENDERERS[display.templateKey];
  if (!renderer) return undefined;
  return renderer(display);
};

const isErrorLikeLabel = (label: string) => {
  const normalized = label.toLowerCase();
  return normalized === "error" || normalized === "reason";
};

const isWarningLikeLabel = (label: string) => {
  const normalized = label.toLowerCase();
  return normalized === "warning" || normalized === "hint";
};

const isAccentFieldLabel = (label: string) => {
  const normalized = label.toLowerCase();
  return [
    "filepath",
    "dirpath",
    "cwd",
    "source",
    "destination",
    "url",
    "command",
    "pattern",
    "sessionid",
    "mode",
    "status",
  ].includes(normalized);
};

const orderFields = (fields: DisplayField[]): DisplayField[] => {
  return [...fields].sort((a, b) => {
    const aError = isErrorLikeLabel(a.label) ? 1 : 0;
    const bError = isErrorLikeLabel(b.label) ? 1 : 0;
    if (aError !== bError) return bError - aError;
    const aWarn = isWarningLikeLabel(a.label) ? 1 : 0;
    const bWarn = isWarningLikeLabel(b.label) ? 1 : 0;
    if (aWarn !== bWarn) return bWarn - aWarn;
    return 0;
  });
};

const getPreviewHeaderText = (title?: string): string => {
  return !title || title === "Preview" ? "Preview:" : `Preview (${title}):`;
};

const getPreviewTone = (previewTitle: string | undefined, line: string): ToolCardLineTone => {
  const normalizedTitle = (previewTitle ?? "").toLowerCase();
  if (normalizedTitle === "stderr") return "stderr";
  if (normalizedTitle === "stdout") return "stdout";
  if (normalizedTitle === "events") {
    if (line.includes(" stderr:")) return "stderr";
    if (line.includes(" stdout:")) return "stdout";
    if (line.includes(" meta:")) return "meta";
    return "preview";
  }
  return "preview";
};

const getSummaryTone = (status: ToolCardTemplateInput["status"]): ToolCardLineTone => {
  if (status === "error") return "error";
  if (status === "running") return "running";
  if (status === "done") return "success";
  return "summary";
};

const collapseInlineText = (text: string, maxChars = 96): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3)}...`;
};

const parseDisplayFields = (display?: ToolDisplayEnvelope): DisplayField[] => {
  if (!isDisplayEnvelope(display)) return [];
  const parsed = parseDisplayData(display);
  return parsed?.fields ?? [];
};

const getFieldValue = (fields: DisplayField[], label: string): string | undefined =>
  fields.find((field) => field.label === label)?.value;

const buildLsCollapsedSummary = (input: ToolCardTemplateInput): string | undefined => {
  const callFields = parseDisplayFields(input.callDisplay);
  const resultFields = parseDisplayFields(input.resultDisplay);
  const dirpath = getFieldValue(callFields, "dirpath") ?? getFieldValue(resultFields, "dirpath");
  const all = getFieldValue(callFields, "all");
  const long = getFieldValue(callFields, "long");
  const entryCount = getFieldValue(resultFields, "entryCount");

  const parts = [
    dirpath ? `dir=${dirpath}` : undefined,
    all ? `all=${all}` : undefined,
    long ? `long=${long}` : undefined,
    entryCount ? `entries=${entryCount}` : undefined,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) return undefined;
  return collapseInlineText(parts.join("  "), 120);
};

const buildGenericCollapsedSummary = (input: ToolCardTemplateInput): string | undefined => {
  if (input.status === "error" && input.errorMessage?.trim()) {
    return collapseInlineText(`error=${input.errorMessage.trim()}`);
  }

  const resultFields = parseDisplayFields(input.resultDisplay);
  const callFields = parseDisplayFields(input.callDisplay);
  const preferredLabels = [
    "filepath",
    "dirpath",
    "source",
    "destination",
    "cwd",
    "url",
    "pattern",
    "mode",
    "action",
    "sessionId",
    "status",
    "append",
    "recursive",
    "overwrite",
    "all",
    "long",
    "entryCount",
    "lineCount",
    "bytes",
    "bytesWritten",
    "exitCode",
  ];

  const byLabel = new Map<string, string>();
  for (const field of [...resultFields, ...callFields]) {
    if (!byLabel.has(field.label)) {
      byLabel.set(field.label, field.value);
    }
  }

  const parts: string[] = [];
  for (const label of preferredLabels) {
    const value = byLabel.get(label);
    if (!value) continue;
    parts.push(`${label}=${value}`);
    if (parts.length >= 3) break;
  }

  if (parts.length === 0) {
    const summaryLine = buildToolCardStyledLines(input).find((line) => line.kind === "summary");
    if (!summaryLine || summaryLine.kind !== "summary") return undefined;
    return collapseInlineText(summaryLine.text.replace(/^Summary:\s*/, ""));
  }

  return collapseInlineText(parts.join("  "), 100);
};

export const buildToolCardCollapsedSummary = (input: ToolCardTemplateInput): string | undefined => {
  if (input.toolName === "ls") {
    return buildLsCollapsedSummary(input) ?? buildGenericCollapsedSummary(input);
  }
  return buildGenericCollapsedSummary(input);
};

const buildStyledLinesFromParsed = (
  parsed: DisplayData,
  status: ToolCardTemplateInput["status"],
): ToolCardStyledLine[] => {
  const lines: ToolCardStyledLine[] = [];

  if (parsed.summary) {
    lines.push({
      kind: "summary",
      text: `Summary: ${parsed.summary}`,
      tone: getSummaryTone(status),
    });
  }

  for (const field of orderFields(parsed.fields ?? [])) {
    let tone: ToolCardLineTone = "default";
    if (isErrorLikeLabel(field.label)) {
      tone = "error";
    } else if (isWarningLikeLabel(field.label)) {
      tone = "warning";
    } else if (isAccentFieldLabel(field.label)) {
      tone = "accent";
    }

    lines.push({
      kind: "field",
      label: field.label,
      value: field.value,
      tone,
    });
  }

  for (const preview of parsed.previews ?? []) {
    if (lines.length > 0) {
      lines.push({ kind: "spacer" });
    }
    lines.push({
      kind: "previewHeader",
      text: getPreviewHeaderText(preview.title),
      tone: "previewHeader",
    });
    for (const previewLine of preview.lines) {
      lines.push({
        kind: "previewLine",
        text: `  ${previewLine}`,
        tone: getPreviewTone(preview.title, previewLine),
      });
    }
    if (preview.truncated) {
      lines.push({
        kind: "previewLine",
        text: "  ...",
        tone: "muted",
      });
    }
  }

  return lines;
};

const buildStyledLinesFromDisplay = (
  display: ToolDisplayEnvelope,
  status: ToolCardTemplateInput["status"],
): ToolCardStyledLine[] | undefined => {
  const parsed = parseDisplayData(display);
  if (!parsed) return undefined;
  const lines = buildStyledLinesFromParsed(parsed, status);
  return lines.length > 0 ? lines : undefined;
};

export const buildToolCardStyledLines = (input: ToolCardTemplateInput): ToolCardStyledLine[] => {
  const displayCandidates = input.status === "running"
    ? [input.callDisplay]
    : [input.resultDisplay, input.callDisplay];

  for (const candidate of displayCandidates) {
    if (!isDisplayEnvelope(candidate)) continue;
    const renderer = TEMPLATE_RENDERERS[candidate.templateKey];
    if (!renderer) continue;
    const lines = buildStyledLinesFromDisplay(candidate, input.status);
    if (lines && lines.length > 0) {
      return lines;
    }
  }

  if (input.status === "running") {
    return [
      {
        kind: "summary",
        text: input.callSummary?.trim() || "Running...",
        tone: "running",
      },
    ];
  }

  if (input.errorMessage?.trim()) {
    return [
      {
        kind: "field",
        label: "error",
        value: input.errorMessage.trim(),
        tone: "error",
      },
      ...(input.resultSummary?.trim()
        ? [
            { kind: "spacer" } as const,
            {
              kind: "previewLine" as const,
              text: input.resultSummary.trim(),
              tone: "muted" as const,
            },
          ]
        : []),
    ];
  }

  if (input.resultSummary?.trim()) {
    return [
      {
        kind: "summary",
        text: input.resultSummary.trim(),
        tone: input.status === "done" ? "success" : "default",
      },
    ];
  }

  if (input.callSummary?.trim()) {
    return [
      {
        kind: "summary",
        text: `Call: ${input.callSummary.trim()}`,
        tone: "muted",
      },
    ];
  }

  return [
    {
      kind: "summary",
      text: "(no output)",
      tone: "muted",
    },
  ];
};

export const renderToolCardBody = (input: ToolCardTemplateInput): string => {
  const lines = buildToolCardStyledLines(input);
  return lines
    .map((line) => {
      switch (line.kind) {
        case "spacer":
          return "";
        case "field":
          return `${line.label}: ${line.value}`;
        default:
          return line.text;
      }
    })
    .join("\n");
};

export type { ToolCardTemplateInput };
