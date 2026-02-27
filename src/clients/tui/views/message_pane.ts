/**
 * TUI 组件：Message Pane（消息流面板）
 * 用于何处：被 `src/clients/tui/runtime/ui.ts` 装配为主界面消息区域，并由 `CoreTuiClientApp` 在每次状态刷新时重绘消息流。
 * 主要职责：构建消息面板骨架、计算工具/TODO 卡片展示状态，并渲染消息流中的动态卡片节点与交互事件。
 *
 * ASCII Layout
 * +----------------------- message pane (box) ------------------------+
 * | topInsetText                                                            |
 * | headerBar -> headerText                                                 |
 * | headerDividerText                                                       |
 * | +--------------------------- scroll ----------------------------------+ |
 * | | listBox                                                             | |
 * | |   card / card / card ...                                            | |
 * | +---------------------------------------------------------------------+ |
 * +-----------------------------------------------------------------------+
 */
import {
  Box,
  BoxRenderable,
  MarkdownRenderable,
  ScrollBox,
  ScrollBoxRenderable,
  SyntaxStyle,
  Text,
  TextRenderable,
  h,
  instantiate,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { effect, signal } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";
import type { ToolDisplayEnvelope } from "../../../types/http";

import type { LayoutMetrics } from "../layout/metrics";
import type { TuiTheme } from "../theme";
import { truncateToDisplayWidth } from "../utils/text";
import {
  buildToolCardCollapsedSummary,
  buildToolCardStyledLines,
  type ToolCardStyledLine,
} from "./tool_templates";

const ASSISTANT_MARKDOWN_SYNTAX_STYLE = SyntaxStyle.create();
const PANEL_INNER_HORIZONTAL_OVERHEAD = 4; // border(2) + paddingX(2)
const MESSAGE_PANEL_VERTICAL_OVERHEAD = 3; // top inset + header row + divider row

// ================================
// 主题兼容层（语义主题 -> 旧布局色位）
// ================================

type MessagePaneLegacyCompatColors = {
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

const getMessagePaneCompatColors = (theme: TuiTheme): MessagePaneLegacyCompatColors => {
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

const mountBox = (
  renderer: CliRenderer,
  options: ConstructorParameters<typeof BoxRenderable>[1],
): BoxRenderable => instantiate(renderer, Box(options)) as unknown as BoxRenderable;

const mountText = (
  renderer: CliRenderer,
  options: ConstructorParameters<typeof TextRenderable>[1],
): TextRenderable => instantiate(renderer, Text(options)) as unknown as TextRenderable;

const mountScrollBox = (
  renderer: CliRenderer,
  options: ConstructorParameters<typeof ScrollBoxRenderable>[1],
): ScrollBoxRenderable => instantiate(renderer, ScrollBox(options)) as unknown as ScrollBoxRenderable;

const mountMarkdown = (
  renderer: CliRenderer,
  options: ConstructorParameters<typeof MarkdownRenderable>[1],
): MarkdownRenderable =>
  instantiate(renderer, h(MarkdownRenderable, options)) as unknown as MarkdownRenderable;

// ================================
// 类型定义区
// ================================

export type MessagePaneSubHeaderInput = {
  phase: "idle" | "submitting" | "polling";
  connection: "unknown" | "ok" | "error";
  taskId?: string;
  agentName: string;
  spinnerFrame: string;
  width: number;
};

export type ChatMessageCardInput =
  | {
      id?: number;
      role: "user" | "assistant" | "system";
      text: string;
      createdAt?: number;
      taskId?: string;
    }
  | {
      id?: number;
      role: "tool";
      toolName: string;
      step?: number;
      callSummary?: string;
      resultSummary?: string;
      errorMessage?: string;
      callDisplay?: ToolDisplayEnvelope;
      resultDisplay?: ToolDisplayEnvelope;
      createdAt?: number;
      collapsed: boolean;
      status: "running" | "done" | "error";
      taskId?: string;
    };

export type ToolGroupSummaryCardInput = {
  role: "tool_group_summary";
  groupKey: string;
  taskId?: string;
  step?: number;
  createdAt?: number;
  executed: number;
  success: number;
  failed: number;
  status: "running" | "done" | "error";
};

export type ToolGroupToggleCardInput = {
  role: "tool_group_toggle";
  groupKey: string;
  taskId?: string;
  step?: number;
  createdAt?: number;
  status: "running" | "done" | "error";
};

export type TodoCardGroupRenderItem = {
  role: "todo_card_group";
  groupKey: string;
  todoId: string;
  taskId?: string;
  step?: number;
  createdAt?: number;
  status: "running" | "done" | "error";
  messages: Array<Extract<ChatMessageCardInput, { role: "tool" }>>;
};

export type MessagePaneRenderItem =
  | ChatMessageCardInput
  | ToolGroupSummaryCardInput
  | ToolGroupToggleCardInput
  | TodoCardGroupRenderItem;

export type ChatMessageCardViewState = {
  role: MessagePaneRenderItem["role"];
  titleText?: string;
  bodyText?: string;
  metaText?: string;
  toolCollapsed?: boolean;
  toolStatus?: "running" | "done" | "error";
};

export type MessagePaneView = {
  box: BoxRenderable;
  headerText: TextRenderable;
  subHeaderText: TextRenderable;
  scroll: ScrollBoxRenderable;
  listBox: BoxRenderable;
};

export type RenderMessageStreamInput = {
  renderer: CliRenderer;
  theme: TuiTheme;
  listBox: BoxRenderable;
  agentName: string;
  items: ChatMessageCardInput[];
  onToggleToolCardCollapse?: (toolMessageId: number, nextCollapsed: boolean) => void;
};

export type MessagePaneRenderInput = {
  layout: LayoutMetrics;
  terminalColumns: number;
  answerFocused: boolean;
  phase: MessagePaneSubHeaderInput["phase"];
  connection: MessagePaneSubHeaderInput["connection"];
  taskId?: string;
  agentName: string;
  spinnerFrame: string;
  items: ChatMessageCardInput[];
  onToggleToolCardCollapse?: (toolMessageId: number, nextCollapsed: boolean) => void;
};

export type MessagePaneViewController = {
  readonly view: MessagePaneView;
  syncFromAppState: (input: MessagePaneRenderInput) => void;
  focus: () => void;
  blur: () => void;
  dispose: () => void;
};

export type CollapseCompletedToolGroupsOptions = {
  expandedGroupKeys?: ReadonlySet<string>;
};

const TOOL_GROUP_COLLAPSE_THRESHOLD_WHEN_COMPLETED = 3;
const TOOL_GROUP_COLLAPSE_THRESHOLD_WHEN_RUNNING = 5;
const expandedToolGroupKeysByListBox = new WeakMap<BoxRenderable, Set<string>>();
const expandedTodoCardKeysByListBox = new WeakMap<BoxRenderable, Set<string>>();

const getExpandedToolGroupKeysForListBox = (listBox: BoxRenderable): Set<string> => {
  let keys = expandedToolGroupKeysByListBox.get(listBox);
  if (!keys) {
    keys = new Set<string>();
    expandedToolGroupKeysByListBox.set(listBox, keys);
  }
  return keys;
};

const getExpandedTodoCardKeysForListBox = (listBox: BoxRenderable): Set<string> => {
  let keys = expandedTodoCardKeysByListBox.get(listBox);
  if (!keys) {
    keys = new Set<string>();
    expandedTodoCardKeysByListBox.set(listBox, keys);
  }
  return keys;
};

const isToolCardInput = (
  item: ChatMessageCardInput,
): item is Extract<ChatMessageCardInput, { role: "tool" }> => item.role === "tool";

const canParticipateInToolGroupCollapse = (
  item: Extract<ChatMessageCardInput, { role: "tool" }>,
): item is Extract<ChatMessageCardInput, { role: "tool" }> & { taskId: string } => {
  return (
    typeof item.taskId === "string" &&
    item.taskId.trim().length > 0 &&
    !item.toolName.startsWith("todo_")
  );
};

const buildToolGroupCollapsedSummaryText = (
  item: ToolGroupSummaryCardInput,
): string => `executed=${item.executed} success=${item.success} failed=${item.failed}`;

const buildToolGroupKey = (taskId: string, startIndex: number): string =>
  `${taskId}:${startIndex}`;

export const collapseCompletedToolGroups = (
  items: readonly ChatMessageCardInput[],
  options: CollapseCompletedToolGroupsOptions = {},
): MessagePaneRenderItem[] => {
  const collapsed: MessagePaneRenderItem[] = [];
  const expandedGroupKeys = options.expandedGroupKeys;

  let index = 0;
  while (index < items.length) {
    const current = items[index];
    if (!current || !isToolCardInput(current) || !canParticipateInToolGroupCollapse(current)) {
      if (current) collapsed.push(current);
      index += 1;
      continue;
    }

    const groupTaskId = current.taskId;
    const groupKey = buildToolGroupKey(groupTaskId, index);
    const group: Extract<ChatMessageCardInput, { role: "tool" }>[] = [];
    let cursor = index;

    while (cursor < items.length) {
      const candidate = items[cursor];
      if (!candidate || !isToolCardInput(candidate) || !canParticipateInToolGroupCollapse(candidate)) {
        break;
      }
      if (candidate.taskId !== groupTaskId) {
        break;
      }
      group.push(candidate);
      cursor += 1;
    }

    const hasRunning = group.some((tool) => tool.status === "running");
    const collapseThreshold = hasRunning
      ? TOOL_GROUP_COLLAPSE_THRESHOLD_WHEN_RUNNING
      : TOOL_GROUP_COLLAPSE_THRESHOLD_WHEN_COMPLETED;
    const shouldCollapse =
      group.length > collapseThreshold &&
      !(expandedGroupKeys && expandedGroupKeys.has(groupKey));

    if (shouldCollapse) {
      const success = group.filter((tool) => tool.status === "done").length;
      const failed = group.filter((tool) => tool.status === "error").length;
      const executed = group.length;
      const numericSteps = group
        .map((tool) => (typeof tool.step === "number" && Number.isFinite(tool.step) ? tool.step : undefined))
        .filter((step): step is number => step !== undefined);
      const uniqueSteps = new Set<number>(numericSteps);
      const summaryStep = uniqueSteps.size === 1 ? numericSteps[0] : undefined;
      collapsed.push({
        role: "tool_group_summary",
        groupKey,
        taskId: groupTaskId,
        step: summaryStep,
        createdAt: group[0]?.createdAt,
        executed,
        success,
        failed,
        status: hasRunning ? "running" : failed > 0 ? "error" : "done",
      });
    } else {
      collapsed.push(...group);
      if (group.length > collapseThreshold && expandedGroupKeys?.has(groupKey)) {
        const failed = group.filter((tool) => tool.status === "error").length;
        const numericSteps = group
          .map((tool) => (typeof tool.step === "number" && Number.isFinite(tool.step) ? tool.step : undefined))
          .filter((step): step is number => step !== undefined);
        const uniqueSteps = new Set<number>(numericSteps);
        const summaryStep = uniqueSteps.size === 1 ? numericSteps[0] : undefined;
        collapsed.push({
          role: "tool_group_toggle",
          groupKey,
          taskId: groupTaskId,
          step: summaryStep,
          createdAt: group[group.length - 1]?.createdAt ?? group[0]?.createdAt,
          status: hasRunning ? "running" : failed > 0 ? "error" : "done",
        });
      }
    }

    index = cursor;
  }

  return collapsed;
};

const getToolStatusColor = (
  theme: TuiTheme,
  status: "running" | "done" | "error",
): string => {
  const NORD = getMessagePaneCompatColors(theme);
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord14;
};

const getToolHeaderTextColor = (
  theme: TuiTheme,
  status: "running" | "done" | "error",
): string => {
  const NORD = getMessagePaneCompatColors(theme);
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord6;
};

const getToolCollapsedSummaryColor = (
  theme: TuiTheme,
  status: "running" | "done" | "error",
): string => {
  const NORD = getMessagePaneCompatColors(theme);
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord4;
  return NORD.nord4;
};

const formatMessageTime = (createdAt?: number): string | undefined => {
  if (!createdAt || !Number.isFinite(createdAt)) return undefined;
  try {
    return new Date(createdAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return undefined;
  }
};

type TodoToolCardProgress = {
  summary?: string;
  total?: number;
  step?: number;
};

type TodoToolCardItem = {
  id?: number;
  title: string;
  status: "open" | "done";
  mark: "✓" | "☐";
};

type TodoToolCardModel = {
  todoId: string;
  actionLabel: string;
  summary: string;
  progress?: TodoToolCardProgress;
  items: TodoToolCardItem[];
};

const isTodoToolName = (toolName: string): boolean => toolName.startsWith("todo_");

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getStringValue = (value: unknown, key: string): string | undefined => {
  if (!isRecordValue(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
};

const getNumberValue = (value: unknown, key: string): number | undefined => {
  if (!isRecordValue(value)) return undefined;
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
};

const normalizeTodoItemStatus = (value: unknown): "open" | "done" | undefined =>
  value === "open" || value === "done" ? value : undefined;

const formatTodoActionLabel = (toolName: string): string =>
  toolName
    .replace(/^todo_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const parseTodoToolCardProgress = (value: unknown): TodoToolCardProgress | undefined => {
  if (!isRecordValue(value)) return undefined;

  const summary = getStringValue(value, "summary");
  const total = getNumberValue(value, "total");
  const step = getNumberValue(value, "step");

  if (summary === undefined && total === undefined && step === undefined) {
    return undefined;
  }

  return {
    ...(summary ? { summary } : {}),
    ...(typeof total === "number" ? { total } : {}),
    ...(typeof step === "number" ? { step } : {}),
  };
};

const parseTodoToolCardItems = (value: unknown): TodoToolCardItem[] => {
  if (!Array.isArray(value)) return [];

  const parsed: TodoToolCardItem[] = [];
  for (const rawItem of value) {
    if (!isRecordValue(rawItem)) continue;
    const title = getStringValue(rawItem, "title");
    const status = normalizeTodoItemStatus(rawItem.status);
    if (!title || !status) continue;
    const id = getNumberValue(rawItem, "id");
    const markRaw = getStringValue(rawItem, "mark");
    const mark = markRaw === "✓" || markRaw === "☐" ? markRaw : status === "done" ? "✓" : "☐";
    parsed.push({
      ...(typeof id === "number" ? { id } : {}),
      title,
      status,
      mark,
    });
  }

  return parsed;
};

const getTodoToolCardModel = (
  item: Extract<ChatMessageCardInput, { role: "tool" }>,
): TodoToolCardModel | undefined => {
  if (!isTodoToolName(item.toolName)) return undefined;

  const displayEnvelope = item.resultDisplay ?? item.callDisplay;
  const displayData = isRecordValue(displayEnvelope?.data) ? displayEnvelope.data : undefined;
  const todoId = getStringValue(displayData, "todo_id") ?? "workspace";
  const progress = parseTodoToolCardProgress(displayData?.progress);
  const items = parseTodoToolCardItems(displayData?.items);
  const dataSummary = getStringValue(displayData, "summary");
  const summary =
    progress?.summary ??
    dataSummary ??
    item.resultSummary ??
    item.callSummary ??
    item.errorMessage ??
    (item.status === "running"
      ? "TODO operation running"
      : item.status === "error"
        ? "TODO operation failed"
        : "TODO operation completed");

  return {
    todoId,
    actionLabel: formatTodoActionLabel(item.toolName),
    summary,
    progress,
    items,
  };
};

const getTodoToolCardGroupKey = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string | undefined => {
  const model = getTodoToolCardModel(item);
  if (!model) return undefined;
  const taskPrefix = item.taskId && item.taskId.trim().length > 0 ? item.taskId.trim() : "no-task";
  return `${taskPrefix}:${model.todoId}`;
};

const isTodoItemsSnapshotMessage = (
  item: Extract<ChatMessageCardInput, { role: "tool" }>,
): boolean => {
  if (item.toolName !== "todo_list") return false;
  if (item.status === "running") return false;
  const model = getTodoToolCardModel(item);
  return Boolean(model && Array.isArray(model.items));
};

export const collapseTodoToolCards = (
  items: readonly MessagePaneRenderItem[],
): MessagePaneRenderItem[] => {
  const collapsed: MessagePaneRenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const current = items[index];
    if (!current || current.role !== "tool") {
      if (current) collapsed.push(current);
      index += 1;
      continue;
    }

    const currentGroupKey = getTodoToolCardGroupKey(current);
    if (!currentGroupKey) {
      collapsed.push(current);
      index += 1;
      continue;
    }

    const groupMessages: Array<Extract<ChatMessageCardInput, { role: "tool" }>> = [current];
    let cursor = index + 1;
    while (cursor < items.length) {
      const candidate = items[cursor];
      if (!candidate || candidate.role !== "tool") break;
      const candidateGroupKey = getTodoToolCardGroupKey(candidate);
      if (candidateGroupKey !== currentGroupKey) break;
      groupMessages.push(candidate);
      cursor += 1;
    }

    const latestSnapshot = [...groupMessages].reverse().find(isTodoItemsSnapshotMessage);
    if (!latestSnapshot) {
      index = cursor;
      continue;
    }

    const status = groupMessages.some((msg) => msg.status === "running")
      ? "running"
      : groupMessages.some((msg) => msg.status === "error")
        ? "error"
        : "done";
    const numericSteps = groupMessages
      .map((tool) => (typeof tool.step === "number" && Number.isFinite(tool.step) ? tool.step : undefined))
      .filter((step): step is number => step !== undefined);
    const step = numericSteps.length > 0 ? numericSteps[numericSteps.length - 1] : undefined;
    const latest = groupMessages[groupMessages.length - 1]!;
    const todoModel = getTodoToolCardModel(latestSnapshot);
    collapsed.push({
      role: "todo_card_group",
      groupKey: currentGroupKey,
      todoId: todoModel?.todoId ?? "workspace",
      taskId: latest.taskId,
      step,
      createdAt: groupMessages[0]?.createdAt,
      status,
      messages: groupMessages,
    });

    index = cursor;
  }

  return collapsed;
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const buildTodoProgressBar = (args: {
  total?: number;
  step?: number;
  summary?: string;
  width?: number;
}): string | undefined => {
  const total = typeof args.total === "number" && args.total > 0 ? Math.floor(args.total) : undefined;
  if (!total) return undefined;

  const rawStep = typeof args.step === "number" ? Math.floor(args.step) : 0;
  const clampedStep = clampNumber(rawStep, 0, total);
  const estimatedCompleted = args.summary?.startsWith("已完成")
    ? total
    : clampNumber(clampedStep > 0 ? clampedStep - 1 : 0, 0, total);
  const width = clampNumber(Math.floor(args.width ?? 18), 8, 32);
  const fill = Math.round((estimatedCompleted / total) * width);
  const filled = "█".repeat(fill);
  const empty = "░".repeat(Math.max(0, width - fill));
  return `${filled}${empty}`;
};

const appendTodoToolCardBody = (args: {
  renderer: CliRenderer;
  theme: TuiTheme;
  bodyWrap: BoxRenderable;
  item: Extract<ChatMessageCardInput, { role: "tool" }>;
  model: TodoToolCardModel;
  cardTitleOverride?: string;
  processMessages?: Array<Extract<ChatMessageCardInput, { role: "tool" }>>;
}) => {
  // UI 渲染区：TODO 卡片的“内容区”构建（折叠态/展开态两种布局）
  const { renderer, theme, bodyWrap, item, model, cardTitleOverride, processMessages: _processMessages } = args;
  const NORD = getMessagePaneCompatColors(theme);
  const isCollapsed = item.collapsed;
  const statusColor = getToolStatusColor(theme, item.status);
  const headerFg = item.status === "done" ? NORD.nord5 : item.status === "error" ? NORD.nord6 : NORD.nord5;
  const progress = model.progress;
  const progressTotal =
    typeof progress?.total === "number" ? Math.max(0, Math.floor(progress.total)) : undefined;
  const progressStep =
    typeof progress?.step === "number" ? Math.max(0, Math.floor(progress.step)) : undefined;
  const progressBar = buildTodoProgressBar({
    total: progressTotal,
    step: progressStep,
    summary: progress?.summary ?? model.summary,
    width: 18,
  });
  const itemsCount = model.items.length;
  const visibleItems = isCollapsed ? [] : model.items;
  const hiddenItemCount = isCollapsed ? itemsCount : 0;
  const titleText = cardTitleOverride ?? `TODO ${model.actionLabel}`;
  const progressText =
    typeof progressStep === "number" || typeof progressTotal === "number"
      ? `${typeof progressStep === "number" ? progressStep : "-"}/${typeof progressTotal === "number" ? progressTotal : "-"}`
      : "-/-";
  const statusText =
    item.status === "running" ? "RUN" : item.status === "error" ? "ERR" : "DONE";
  const hasNoItems = itemsCount === 0;
  const TODO_TITLE_CELL_WIDTH = 16;
  const TODO_STEP_BADGE_WIDTH = 15;
  const TODO_ITEMS_BADGE_WIDTH = 13;
  const TODO_STATUS_BADGE_WIDTH = 8;
  const makeTodoHeaderCell = (content: string, fg: string, width: number) =>
    mountText(renderer, {
      content,
      fg,
      width,
      truncate: true,
    });

  const frame = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord1,
  });

  if (isCollapsed) {
    // UI 渲染区：折叠态 = 单行标题 + 进度条（可选）+ 展开提示
    const collapsedMetaParts = [
      `step ${progressText}`,
      `${itemsCount} item${itemsCount === 1 ? "" : "s"}`,
      statusText,
    ];
    const collapsedHeader = mountBox(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: NORD.nord2,
      paddingLeft: 1,
      paddingRight: 1,
    });
    collapsedHeader.add(mountText(renderer, { content: "▸", fg: NORD.nord8 }));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(mountText(renderer, { content: "●", fg: statusColor }));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(titleText, headerFg, TODO_TITLE_CELL_WIDTH));
    collapsedHeader.add(mountText(renderer, { content: " ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(`[${collapsedMetaParts[0] ?? ""}]`, NORD.nord8, TODO_STEP_BADGE_WIDTH));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(`[${collapsedMetaParts[1] ?? ""}]`, NORD.nord4, TODO_ITEMS_BADGE_WIDTH));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(`[${collapsedMetaParts[2] ?? ""}]`, statusColor, TODO_STATUS_BADGE_WIDTH));
    collapsedHeader.add(
      mountText(renderer, {
        content: `  —  ${model.summary}`,
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );
    frame.add(collapsedHeader);

    if (progressBar) {
      const barRow = mountBox(renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: NORD.nord1,
        paddingLeft: 1,
        paddingRight: 1,
      });
      barRow.add(
        mountText(renderer, {
          content: progressBar,
          fg: NORD.nord8,
          width: "100%",
          truncate: true,
        }),
      );
      frame.add(barRow);
    }

    const hintRow = mountBox(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: NORD.nord1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    hintRow.add(
      mountText(renderer, {
        content:
          itemsCount > 0
            ? `点击展开查看 ${itemsCount} 个 TODO 项`
            : "点击展开查看详情",
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );
    frame.add(hintRow);

    bodyWrap.add(frame);
    return;
  }

  const expandedMetaParts = [
    { text: `step ${progressText}`, fg: NORD.nord8 },
    { text: `${itemsCount} item${itemsCount === 1 ? "" : "s"}`, fg: NORD.nord4 },
    { text: statusText, fg: statusColor },
  ] as const;
  const headerRow = mountBox(renderer, {
    width: "100%",
    flexDirection: "row",
    backgroundColor: NORD.nord2,
    paddingLeft: 1,
    paddingRight: 1,
  });
  headerRow.add(mountText(renderer, { content: "▾", fg: NORD.nord8 }));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(mountText(renderer, { content: "●", fg: statusColor }));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(titleText, headerFg, TODO_TITLE_CELL_WIDTH));
  headerRow.add(mountText(renderer, { content: " ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(`[${expandedMetaParts[0].text}]`, expandedMetaParts[0].fg, TODO_STEP_BADGE_WIDTH));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(`[${expandedMetaParts[1].text}]`, expandedMetaParts[1].fg, TODO_ITEMS_BADGE_WIDTH));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(`[${expandedMetaParts[2].text}]`, expandedMetaParts[2].fg, TODO_STATUS_BADGE_WIDTH));
  headerRow.add(
    mountText(renderer, {
      content: `  —  ${model.summary}`,
      fg: item.status === "error" ? NORD.nord11 : NORD.nord4,
      width: "100%",
      truncate: true,
    }),
  );
  frame.add(headerRow);

  if (hasNoItems) {
    // UI 渲染区：展开态但暂无列表项时，显示简化内容块
    const compactWrap = mountBox(renderer, {
      width: "100%",
      flexDirection: "column",
      backgroundColor: NORD.nord1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    });

    const metaRow = mountBox(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: NORD.nord1,
    });
    metaRow.add(mountText(renderer, { content: "TODO Items", fg: NORD.nord9 }));
    metaRow.add(
      mountText(renderer, {
        content: "  0",
        fg: NORD.nord4,
        width: "100%",
        truncate: true,
      }),
    );
    compactWrap.add(metaRow);

    compactWrap.add(
      mountText(renderer, {
        content: "No TODO items yet",
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );

    frame.add(compactWrap);
    bodyWrap.add(frame);
    return;
  }

  const contentColumn = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord1,
  });

  const itemsSection = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord1,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
  });
  const itemsHeader = mountBox(renderer, {
    width: "100%",
    flexDirection: "row",
    backgroundColor: NORD.nord1,
  });
  itemsHeader.add(mountText(renderer, { content: "Items", fg: NORD.nord9 }));
  itemsHeader.add(
    mountText(renderer, {
      content: itemsCount > 0 ? `  ${itemsCount}` : "  0",
      fg: NORD.nord4,
      width: "100%",
      truncate: true,
    }),
  );
  itemsSection.add(itemsHeader);

  if (visibleItems.length === 0) {
    itemsSection.add(
      mountText(renderer, {
        content: hiddenItemCount > 0 ? `… 还有 ${hiddenItemCount} 项` : "暂无可显示的 TODO 项",
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );
  } else {
    // UI 渲染区：展开态 TODO 项列表
    for (const todoItem of visibleItems) {
      const itemRow = mountBox(renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: NORD.nord1,
      });
      itemRow.add(
        mountText(renderer, {
          content: `${todoItem.mark} `,
          fg: todoItem.status === "done" ? NORD.nord14 : NORD.nord8,
        }),
      );
      if (typeof todoItem.id === "number") {
        itemRow.add(
          mountText(renderer, {
            content: `#${todoItem.id} `,
            fg: NORD.nord3,
          }),
        );
      }
      itemRow.add(
        mountText(renderer, {
          content: todoItem.title,
          fg: todoItem.status === "done" ? NORD.nord4 : NORD.nord6,
          width: "100%",
          wrapMode: "char",
        }),
      );
      itemsSection.add(itemRow);
    }
  }
  contentColumn.add(itemsSection);

  frame.add(contentColumn);
  bodyWrap.add(frame);
};

const getToolLineTextColor = (theme: TuiTheme, line: ToolCardStyledLine): string => {
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

const getToolDisplayFields = (display?: ToolDisplayEnvelope): ToolDisplayField[] => {
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

const getBashDisplayFieldValue = (
  item: Extract<ChatMessageCardInput, { role: "tool" }>,
  label: string,
): string | undefined => {
  const resultFields = getToolDisplayFields(item.resultDisplay);
  const callFields = getToolDisplayFields(item.callDisplay);
  return getToolDisplayFieldValue(resultFields, label) ?? getToolDisplayFieldValue(callFields, label);
};

const getBashToolCommandText = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string => {
  const command = getBashDisplayFieldValue(item, "command");

  if (command && command.trim().length > 0) {
    return command;
  }
  if (item.callSummary?.trim()) return item.callSummary.trim();
  if (item.resultSummary?.trim()) return item.resultSummary.trim();
  return "bash";
};

const getBashToolCwdText = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string => {
  const cwd = getBashDisplayFieldValue(item, "cwd");
  if (cwd && cwd.trim().length > 0) return cwd;
  return getBashToolCommandText(item);
};

const getBashToolTitleText = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string => {
  const cwd = getBashToolCwdText(item).trim();
  const command = getBashToolCommandText(item).trim();
  if (cwd.length > 0 && command.length > 0) return `${cwd} | ${command}`;
  if (cwd.length > 0) return cwd;
  if (command.length > 0) return command;
  return "bash";
};

const stringifyToolStyledLine = (line: ToolCardStyledLine): string => {
  if (line.kind === "spacer") return "";
  if (line.kind === "field") return `${line.label}: ${line.value}`;
  return line.text;
};

const appendBashToolCardBody = (args: {
  renderer: CliRenderer;
  theme: TuiTheme;
  bodyWrap: BoxRenderable;
  item: Extract<ChatMessageCardInput, { role: "tool" }>;
}) => {
  const { renderer, theme, bodyWrap, item } = args;
  const NORD = getMessagePaneCompatColors(theme);
  const statusColor = getToolStatusColor(theme, item.status);
  const commandText = getBashToolCommandText(item);
  const titleText = item.collapsed ? getBashToolTitleText(item) : getBashToolCwdText(item);
  const lines = buildToolCardStyledLines(item);
  const outputLines = lines.filter((line) => line.kind === "previewLine");
  const runtimeHintRows = item.status === "running" && outputLines.length === 0 ? 1 : 0;
  const contentRows = 1 + (outputLines.length > 0 ? 1 + outputLines.length : runtimeHintRows);
  const lineHeight = Math.max(2, Math.min(5, contentRows));

  const frame = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord2,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });
  frame.add(
    mountText(renderer, {
      content: " ",
      fg: NORD.nord2,
      width: "100%",
      truncate: true,
    }),
  );

  const headerRow = mountBox(renderer, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    backgroundColor: NORD.nord2,
    paddingLeft: 0,
    paddingRight: 1,
  });
  const bashBadge = mountBox(renderer, {
    flexDirection: "row",
    height: 1,
    width: 6,
    backgroundColor: NORD.nord14,
    paddingLeft: 1,
    paddingRight: 1,
  });
  bashBadge.add(
    mountText(renderer, {
      content: "BASH",
      fg: NORD.nord0,
      width: "100%",
      truncate: true,
    }),
  );
  headerRow.add(bashBadge);
  headerRow.add(
    mountText(renderer, {
      content: "  ",
      fg: NORD.nord3,
    }),
  );
  headerRow.add(
    mountText(renderer, {
      content: titleText,
      fg: NORD.nord6,
      width: "100%",
      truncate: true,
    }),
  );
  frame.add(headerRow);

  if (item.collapsed) {
    frame.add(
      mountText(renderer, {
        content: " ",
        fg: NORD.nord2,
        width: "100%",
        truncate: true,
      }),
    );
    frame.add(
      mountText(renderer, {
        content: "[ + 展开 ]",
        fg: statusColor,
      }),
    );
    frame.add(
      mountText(renderer, {
        content: " ",
        fg: NORD.nord2,
        width: "100%",
        truncate: true,
      }),
    );
    bodyWrap.add(frame);
    return;
  }

  const panelBox = mountBox(renderer, {
    width: "100%",
    height: lineHeight,
    flexDirection: "column",
    backgroundColor: NORD.nord2,
    marginTop: 1,
    paddingLeft: 0,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });
  const panelContent = mountBox(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord2,
  });
  panelBox.add(panelContent);
  frame.add(panelBox);
  const contentRowsToRender: Array<{ text: string; fg: string }> = [
    { text: `$ ${commandText}`, fg: NORD.nord8 },
  ];
  if (outputLines.length > 0) {
    contentRowsToRender.push({ text: "", fg: NORD.nord3 });
    for (const line of outputLines) {
      contentRowsToRender.push({
        text: stringifyToolStyledLine(line),
        fg: getToolLineTextColor(theme, line),
      });
    }
  } else if (item.status === "running") {
    contentRowsToRender.push({ text: "Running...", fg: NORD.nord4 });
  }

  const visibleRows = contentRowsToRender.length > lineHeight
    ? [
        contentRowsToRender[0]!,
        ...contentRowsToRender.slice(-(lineHeight - 1)),
      ]
    : contentRowsToRender;

  for (const row of visibleRows) {
    panelContent.add(
      mountText(renderer, {
        content: row.text,
        fg: row.fg,
        width: "100%",
        wrapMode: "char",
      }),
    );
  }

  for (let index = visibleRows.length; index < lineHeight; index += 1) {
    panelContent.add(
      mountText(renderer, {
        content: "",
        fg: NORD.nord3,
        width: "100%",
      }),
    );
  }

  frame.add(
    mountText(renderer, {
      content: "",
      fg: NORD.nord3,
      width: "100%",
    }),
  );
  frame.add(
    mountText(renderer, {
      content: "[ - 折叠 ]",
      fg: statusColor,
    }),
  );
  frame.add(
    mountText(renderer, {
      content: " ",
      fg: NORD.nord2,
      width: "100%",
      truncate: true,
    }),
  );
  bodyWrap.add(frame);
};

export const createMessagePaneView = (ctx: CliRenderer, theme: TuiTheme): MessagePaneView => {
  // UI 渲染区：消息面板骨架（header + divider + scroll 内容区）
  const NORD = getMessagePaneCompatColors(theme);
  const box = mountBox(ctx, {
    border: true,
    borderStyle: "single",
    backgroundColor: NORD.nord0,
    paddingX: 1,
    width: "100%",
    flexDirection: "column",
    flexGrow: 1,
  });
  const topInsetText = mountText(ctx, {
    content: " ",
    fg: NORD.nord0,
    width: "100%",
    truncate: true,
  });
  const headerBar = mountBox(ctx, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    backgroundColor: NORD.nord2,
    paddingX: 0,
  });
  const headerText = mountText(ctx, {
    content: "Conversation",
    fg: NORD.nord4,
    width: "100%",
    truncate: true,
  });
  const headerDividerText = mountText(ctx, {
    content: "─".repeat(512),
    fg: NORD.nord1,
    width: "100%",
    truncate: true,
  });
  const subHeaderText = mountText(ctx, {
    content: "Ready",
    fg: NORD.nord3,
    width: "100%",
    truncate: true,
    visible: false,
  });
  const scroll = mountScrollBox(ctx, {
    width: "100%",
    height: 1,
    scrollX: false,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    rootOptions: {
      backgroundColor: NORD.nord0,
    },
    wrapperOptions: {
      backgroundColor: NORD.nord0,
    },
    viewportOptions: {
      backgroundColor: NORD.nord0,
    },
    contentOptions: {
      backgroundColor: NORD.nord0,
    },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: NORD.nord3,
        backgroundColor: NORD.nord1,
      },
    },
  });
  const listBox = mountBox(ctx, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord0,
    paddingBottom: 1,
  });

  scroll.add(listBox);
  box.add(topInsetText);
  headerBar.add(headerText);
  box.add(headerBar);
  box.add(headerDividerText);
  box.add(scroll);

  return {
    box,
    headerText,
    subHeaderText,
    scroll,
    listBox,
  };
};

export const buildMessageHeaderLine = (
  agentName: string,
  count: number,
  width: number,
): string => {
  const label = count === 1 ? "message" : "messages";
  return truncateToDisplayWidth(`${agentName} : ${count} ${label}`, width);
};

export const buildMessageSubHeaderLine = (
  args: MessagePaneSubHeaderInput,
): string => {
  void args;
  return " ";
};

// ================================
// 运行时注入区（将实时状态数据注入组件）
// ================================

export const updateMessagePaneView = (
  args: {
    renderer: CliRenderer;
    view: MessagePaneView;
    theme: TuiTheme;
    input: MessagePaneRenderInput;
  },
): void => {
  const { renderer, view, theme, input } = args;
  const headerWidth = Math.max(1, input.terminalColumns - PANEL_INNER_HORIZONTAL_OVERHEAD);

  view.box.height = input.layout.messageHeight;
  view.box.borderColor = input.answerFocused
    ? theme.colors.borderAccentSecondary
    : theme.colors.borderDefault;
  view.headerText.visible = true;
  view.subHeaderText.visible = false;

  view.headerText.content = buildMessageHeaderLine(
    input.agentName,
    input.items.length,
    headerWidth,
  );
  view.subHeaderText.content = buildMessageSubHeaderLine({
    phase: input.phase,
    connection: input.connection,
    taskId: input.taskId,
    agentName: input.agentName,
    spinnerFrame: input.spinnerFrame,
    width: headerWidth,
  });

  view.scroll.height = Math.max(1, input.layout.messageHeight - MESSAGE_PANEL_VERTICAL_OVERHEAD);
  renderMessageStreamContent({
    renderer,
    theme,
    listBox: view.listBox,
    agentName: input.agentName,
    items: input.items,
    onToggleToolCardCollapse: input.onToggleToolCardCollapse,
  });
};

// ================================
// 响应式绑定区（Signal -> 视图同步）
// ================================

export const bindMessagePaneViewModel = (
  args: {
    renderer: CliRenderer;
    view: MessagePaneView;
    theme: TuiTheme;
    inputSignal: ReadonlySignal<MessagePaneRenderInput | null>;
    isDestroyed?: () => boolean;
  },
): (() => void) => effect(() => {
  if (args.isDestroyed?.()) return;
  const input = args.inputSignal.value;
  if (!input) return;
  updateMessagePaneView({
    renderer: args.renderer,
    view: args.view,
    theme: args.theme,
    input,
  });
});

export const createMessagePaneViewController = (
  args: {
    renderer: CliRenderer;
    theme: TuiTheme;
    isDestroyed?: () => boolean;
  },
): MessagePaneViewController => {
  const view = createMessagePaneView(args.renderer, args.theme);
  const renderInputSignal = signal<MessagePaneRenderInput | null>(null);
  const disposeSync = bindMessagePaneViewModel({
    renderer: args.renderer,
    view,
    theme: args.theme,
    inputSignal: renderInputSignal,
    isDestroyed: args.isDestroyed,
  });

  return {
    view,
    syncFromAppState: (input) => {
      renderInputSignal.value = input;
    },
    focus: () => {
      view.scroll.focus();
    },
    blur: () => {
      view.scroll.blur();
    },
    dispose: () => {
      disposeSync();
    },
  };
};

export const buildChatMessageCardViewState = (
  item: MessagePaneRenderItem,
): ChatMessageCardViewState => {
  if (item.role === "tool_group_summary") {
    return {
      role: "tool_group_summary",
      titleText: "tools",
      toolCollapsed: true,
      toolStatus: item.status,
      metaText: `tools${item.taskId ? ` : ${item.taskId}` : ""}${typeof item.step === "number" ? ` step ${item.step}` : ""}`,
    };
  }

  if (item.role === "tool_group_toggle") {
    return {
      role: "tool_group_toggle",
      titleText: "点击折叠",
      toolCollapsed: true,
      toolStatus: item.status,
      metaText: `tools${item.taskId ? ` : ${item.taskId}` : ""}${typeof item.step === "number" ? ` step ${item.step}` : ""}`,
    };
  }

  if (item.role === "todo_card_group") {
    return {
      role: "todo_card_group",
      titleText: "TODO",
      toolCollapsed: true,
      toolStatus: item.status,
      metaText: `todo${item.taskId ? ` : ${item.taskId}` : ""}${typeof item.step === "number" ? ` step ${item.step}` : ""}`,
    };
  }

  if (item.role === "tool") {
    return {
      role: "tool",
      titleText: item.toolName.length > 0 ? item.toolName : "tool",
      toolCollapsed: item.collapsed,
      toolStatus: item.status,
      metaText: `tool${item.taskId ? ` : ${item.taskId}` : ""}`,
    };
  }

  const isUser = item.role === "user";
  const isSystem = item.role === "system";
  return {
    role: item.role,
    bodyText: item.text.length > 0 ? item.text : " ",
    metaText: isUser
      ? (formatMessageTime(item.createdAt) ??
        (item.taskId ? `user | ${item.taskId}` : undefined))
      : isSystem
        ? `system${item.taskId ? ` | ${item.taskId}` : ""}`
        : undefined,
  };
};

export const renderMessageStreamContent = (
  input: RenderMessageStreamInput,
): void => {
  // 逻辑区：每次重渲染前先清空旧节点，避免残留和重复绑定事件
  const NORD = getMessagePaneCompatColors(input.theme);
  const children = [...input.listBox.getChildren()];
  for (const child of children) {
    input.listBox.remove(child.id);
    if (!child.isDestroyed) child.destroyRecursively();
  }

  const expandedToolGroupKeys = getExpandedToolGroupKeysForListBox(input.listBox);
  const expandedTodoCardKeys = getExpandedTodoCardKeysForListBox(input.listBox);
  const renderItems = collapseTodoToolCards(
    collapseCompletedToolGroups(input.items, {
      expandedGroupKeys: expandedToolGroupKeys,
    }),
  );

  if (renderItems.length === 0) {
    // 部件说明：空态容器（给首屏留出顶部间距，避免文本贴边）。
    const emptyWrap = mountBox(input.renderer, {
      width: "100%",
      backgroundColor: NORD.nord0,
      paddingTop: 1,
    });
    // 部件说明：空态文案（在没有任何消息时提示用户可开始输入）。
    const emptyText = mountText(input.renderer, {
      content: `${input.agentName} is ready. Type a message below.`,
      fg: NORD.nord3,
      width: "100%",
      wrapMode: "char",
    });
    emptyWrap.add(emptyText);
    input.listBox.add(emptyWrap);
    return;
  }

  for (const [index, item] of renderItems.entries()) {
    // 逻辑区：根据消息类型决定卡片布局规则（tool-like / todo-like / plain message）
    const cardState = buildChatMessageCardViewState(item);
    const isUser = cardState.role === "user";
    const isSystem = cardState.role === "system";
    const isAssistant = cardState.role === "assistant";
    const isTool = cardState.role === "tool";
    const isTodoCardGroup = cardState.role === "todo_card_group";
    const todoCardGroup = isTodoCardGroup ? (item as TodoCardGroupRenderItem) : undefined;
    const toolItem = isTool ? (item as Extract<ChatMessageCardInput, { role: "tool" }>) : undefined;
    const isBashToolCard = Boolean(toolItem && toolItem.toolName === "bash");
    const todoToolCardModel = toolItem ? getTodoToolCardModel(toolItem) : undefined;
    const isTodoToolCard = Boolean(todoToolCardModel);
    const isToolGroupSummary = cardState.role === "tool_group_summary";
    const isToolGroupToggle = cardState.role === "tool_group_toggle";
    const isToolLike = isTool || isToolGroupSummary || isToolGroupToggle || isTodoCardGroup;
    const previousItem = index > 0 ? renderItems[index - 1] : undefined;
    const previousRole = previousItem?.role;
    const previousIsToolLike =
      previousRole === "tool" ||
      previousRole === "todo_card_group" ||
      previousRole === "tool_group_summary" ||
      previousRole === "tool_group_toggle";
    const groupedPlainText =
      (isAssistant || isSystem) && previousRole === cardState.role;
    const toolMarginTop =
      isToolLike && previousItem
        ? isTodoToolCard
          ? 1
          : previousIsToolLike
            ? 0
            : 1
        : 0;
    const isTodoCardLike = isTodoToolCard || isTodoCardGroup;
    const isCompactTool = isToolLike && !isTodoCardLike && !isBashToolCard;
    const toolBorderEnabled = isTodoCardLike;
    const cardBackgroundColor = isTodoCardLike
      ? NORD.nord1
      : isBashToolCard
        ? NORD.nord2
      : isCompactTool
      ? NORD.nord0
      : isUser
        ? NORD.nord1
        : NORD.nord0;
    // 部件说明：单条消息/工具卡片根容器，负责边框、背景和外边距。
    const card = mountBox(input.renderer, {
      width: "100%",
      flexDirection: isTodoCardLike || isBashToolCard ? "column" : "row",
      marginTop:
        index === 0 ? 1 : isToolLike ? toolMarginTop : groupedPlainText ? 0 : 1,
      border: toolBorderEnabled,
      borderStyle: toolBorderEnabled ? "single" : undefined,
      borderColor:
        toolBorderEnabled
          ? getToolStatusColor(input.theme, cardState.toolStatus ?? "done")
          : undefined,
      backgroundColor: cardBackgroundColor,
    });

    // 事件处理区：工具组与 TODO 卡片的点击展开/折叠逻辑（只处理左键）
    if (isToolGroupSummary) {
      const summaryItem = item as ToolGroupSummaryCardInput;
      card.onMouseUp = (event) => {
        if (event.button !== 0) return;
        expandedToolGroupKeys.add(summaryItem.groupKey);
        event.stopPropagation();
        event.preventDefault();
        renderMessageStreamContent(input);
        input.renderer.requestRender();
      };
    }
    if (isToolGroupToggle) {
      const toggleItem = item as ToolGroupToggleCardInput;
      card.onMouseUp = (event) => {
        if (event.button !== 0) return;
        expandedToolGroupKeys.delete(toggleItem.groupKey);
        event.stopPropagation();
        event.preventDefault();
        renderMessageStreamContent(input);
        input.renderer.requestRender();
      };
    }
    if (
      isTool &&
      isTodoToolCard &&
      typeof toolItem?.id === "number" &&
      typeof input.onToggleToolCardCollapse === "function"
    ) {
      card.onMouseUp = (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        input.onToggleToolCardCollapse!(toolItem.id!, !toolItem.collapsed);
      };
    }
    if (
      isTool &&
      isBashToolCard &&
      typeof toolItem?.id === "number" &&
      typeof input.onToggleToolCardCollapse === "function"
    ) {
      card.onMouseUp = (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        input.onToggleToolCardCollapse!(toolItem.id!, !toolItem.collapsed);
      };
    }
    if (isTodoCardGroup && todoCardGroup) {
      card.onMouseUp = (event) => {
        if (event.button !== 0) return;
        if (expandedTodoCardKeys.has(todoCardGroup.groupKey)) {
          expandedTodoCardKeys.delete(todoCardGroup.groupKey);
        } else {
          expandedTodoCardKeys.add(todoCardGroup.groupKey);
        }
        event.stopPropagation();
        event.preventDefault();
        renderMessageStreamContent(input);
        input.renderer.requestRender();
      };
    }

    const bodyWrap = mountBox(input.renderer, {
      width: "100%",
      flexDirection: "column",
      paddingLeft: isTodoCardLike ? 0 : isToolLike ? 0 : 1,
      paddingRight: isTodoCardLike ? 0 : 1,
      paddingTop: isTodoCardLike ? 0 : isToolLike ? 0 : isUser ? 1 : 0,
      paddingBottom: isTodoCardLike ? 0 : isToolLike ? 0 : isUser ? 1 : 0,
      backgroundColor: cardBackgroundColor,
    });

    // 部件说明：普通消息的元信息行（时间戳 / taskId 等）；tool-like 卡片通常不显示。
    const meta = cardState.metaText
      ? mountText(input.renderer, {
          content: cardState.metaText,
          fg: NORD.nord3,
          width: "100%",
          truncate: true,
        })
      : undefined;

    if (isTodoCardGroup && todoCardGroup) {
      // UI 渲染区：TODO workflow 聚合卡片（使用最新快照 + 最新状态合并）
      const latestMessage = [...todoCardGroup.messages]
        .reverse()
        .find((message) => Boolean(getTodoToolCardModel(message))) ?? todoCardGroup.messages[todoCardGroup.messages.length - 1];
      const latestSnapshotMessage = [...todoCardGroup.messages]
        .reverse()
        .find(isTodoItemsSnapshotMessage);
      const latestModel = latestMessage ? getTodoToolCardModel(latestMessage) : undefined;
      const snapshotModel = latestSnapshotMessage ? getTodoToolCardModel(latestSnapshotMessage) : undefined;
      if (latestMessage && latestModel && snapshotModel) {
        const mergedTodoModel: TodoToolCardModel = {
          ...snapshotModel,
          summary: latestModel.summary,
          progress: latestModel.progress ?? snapshotModel.progress,
        };
        appendTodoToolCardBody({
          renderer: input.renderer,
          theme: input.theme,
          bodyWrap,
          item: {
            ...latestMessage,
            collapsed: !expandedTodoCardKeys.has(todoCardGroup.groupKey),
            status: todoCardGroup.status,
          },
          model: mergedTodoModel,
          cardTitleOverride: "TODO Workflow",
        });
      }
    } else if (isTool && isTodoToolCard && toolItem && todoToolCardModel) {
      // UI 渲染区：单个 TODO 工具卡片
      appendTodoToolCardBody({
        renderer: input.renderer,
        theme: input.theme,
        bodyWrap,
        item: toolItem,
        model: todoToolCardModel,
      });
    } else if (isTool && isBashToolCard && toolItem) {
      appendBashToolCardBody({
        renderer: input.renderer,
        theme: input.theme,
        bodyWrap,
        item: toolItem,
      });
    } else if (isToolLike) {
      // UI 渲染区：紧凑工具行（状态标记 + [toolName] + 摘要）
      const toolStatus = cardState.toolStatus ?? "done";
      // Compact tool row format contract:
      // "<status> [<toolName>] | <collapsed summary>"
      // Keep the trailing space after the status glyph so the symbol and tool name never touch.
      const statusMark =
        isToolGroupToggle
          ? ""
          : toolStatus === "error"
            ? "✕ "
            : toolStatus === "running"
              ? "… "
              : "✓ ";
      const collapsedSummary = isTool
        ? buildToolCardCollapsedSummary(item as Extract<ChatMessageCardInput, { role: "tool" }>)
        : isToolGroupSummary
          ? buildToolGroupCollapsedSummaryText(item as ToolGroupSummaryCardInput)
          : undefined;

      const titleRow = mountBox(input.renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: cardBackgroundColor,
        paddingLeft: 1,
      });
      // 部件说明：工具行状态标记（运行/成功/失败符号）。
      const titleStatusText = mountText(input.renderer, {
        content: isToolGroupToggle ? "" : `${statusMark} `,
        fg: getToolStatusColor(input.theme, toolStatus),
      });
      // 部件说明：工具名称前缀（如 [read] / [bash] / [tools]）。
      const titlePrefixText = mountText(input.renderer, {
        content: `[${cardState.titleText ?? "tool"}]`,
        fg:
          isToolGroupSummary || isToolGroupToggle
            ? getToolStatusColor(input.theme, toolStatus)
            : NORD.nord4,
      });
      titleRow.add(titleStatusText);
      titleRow.add(titlePrefixText);

      if (collapsedSummary) {
        // 部件说明：折叠摘要文本（展示关键结果或统计信息）。
        const titleSummaryText = mountText(input.renderer, {
          content: ` ${collapsedSummary}`,
          fg: isToolGroupSummary
            ? getToolStatusColor(input.theme, toolStatus)
            : getToolCollapsedSummaryColor(input.theme, toolStatus),
          width: "100%",
          truncate: true,
        });
        titleRow.add(titleSummaryText);
      } else {
        // 部件说明：占位空白，保证行内布局稳定。
        const titleSpacer = mountText(input.renderer, {
          content: " ",
          fg: NORD.nord3,
          width: "100%",
        });
        titleRow.add(titleSpacer);
      }
      bodyWrap.add(titleRow);
    } else {
      // UI 渲染区：普通消息（assistant 使用 Markdown，其余使用纯文本）
      if (cardState.role === "assistant") {
        // 部件说明：assistant 正文使用 Markdown 渲染，保留格式与代码块展示能力。
        const markdown = mountMarkdown(input.renderer, {
          content: cardState.bodyText ?? " ",
          syntaxStyle: ASSISTANT_MARKDOWN_SYNTAX_STYLE,
          conceal: true,
          streaming: false,
          width: "100%",
        });
        bodyWrap.add(markdown);
      } else {
        // 部件说明：user/system/other 正文使用普通文本节点。
        const bodyText = mountText(input.renderer, {
          content: cardState.bodyText ?? " ",
          fg: isUser ? NORD.nord5 : isSystem ? NORD.nord8 : NORD.nord4,
          width: "100%",
          wrapMode: "char",
        });
        bodyWrap.add(bodyText);
      }
    }

    if (!isToolLike && meta) {
      bodyWrap.add(meta);
    }
    if (!isToolLike && !isAssistant) {
      // UI 渲染区：普通消息左侧强调线（用户/系统/其他颜色不同）
      const accent = mountBox(input.renderer, {
        width: 1,
        border: ["left"],
        borderStyle: "single",
        borderColor: isUser ? NORD.nord9 : isSystem ? NORD.nord8 : NORD.nord3,
        shouldFill: false,
        backgroundColor: cardBackgroundColor,
      });
      card.add(accent);
    }
    card.add(bodyWrap);
    input.listBox.add(card);
  }
};
