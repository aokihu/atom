import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { ToolDisplayEnvelope } from "../../../types/http";

import { NORD } from "../theme/nord";
import { truncateToDisplayWidth } from "../utils/text";
import {
  buildToolCardCollapsedSummary,
  buildToolCardStyledLines,
  type ToolCardStyledLine,
} from "./tool_templates";

const ASSISTANT_MARKDOWN_SYNTAX_STYLE = SyntaxStyle.create();

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
      role: "user" | "assistant" | "system";
      text: string;
      createdAt?: number;
      taskId?: string;
    }
  | {
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
  taskId?: string;
  step: number;
  createdAt?: number;
  executed: number;
  success: number;
  failed: number;
  status: "done" | "error";
};

export type MessagePaneRenderItem = ChatMessageCardInput | ToolGroupSummaryCardInput;

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
  listBox: BoxRenderable;
  agentName: string;
  items: ChatMessageCardInput[];
};

const isToolCardInput = (
  item: ChatMessageCardInput,
): item is Extract<ChatMessageCardInput, { role: "tool" }> => item.role === "tool";

const canParticipateInToolGroupCollapse = (
  item: Extract<ChatMessageCardInput, { role: "tool" }>,
): item is Extract<ChatMessageCardInput, { role: "tool" }> & { taskId: string; step: number } => {
  return (
    typeof item.taskId === "string" &&
    item.taskId.trim().length > 0 &&
    typeof item.step === "number" &&
    Number.isFinite(item.step)
  );
};

const buildToolGroupCollapsedSummaryText = (
  item: ToolGroupSummaryCardInput,
): string => `executed=${item.executed} success=${item.success} failed=${item.failed}`;

export const collapseCompletedToolGroups = (
  items: readonly ChatMessageCardInput[],
): MessagePaneRenderItem[] => {
  const collapsed: MessagePaneRenderItem[] = [];

  let index = 0;
  while (index < items.length) {
    const current = items[index];
    if (!current || !isToolCardInput(current) || !canParticipateInToolGroupCollapse(current)) {
      if (current) collapsed.push(current);
      index += 1;
      continue;
    }

    const groupTaskId = current.taskId;
    const groupStep = current.step;
    const group: Extract<ChatMessageCardInput, { role: "tool" }>[] = [];
    let cursor = index;

    while (cursor < items.length) {
      const candidate = items[cursor];
      if (!candidate || !isToolCardInput(candidate) || !canParticipateInToolGroupCollapse(candidate)) {
        break;
      }
      if (candidate.taskId !== groupTaskId || candidate.step !== groupStep) {
        break;
      }
      group.push(candidate);
      cursor += 1;
    }

    const hasRunning = group.some((tool) => tool.status === "running");
    if (group.length >= 2 && !hasRunning) {
      const failed = group.filter((tool) => tool.status === "error").length;
      const executed = group.length;
      const success = executed - failed;
      collapsed.push({
        role: "tool_group_summary",
        taskId: groupTaskId,
        step: groupStep,
        createdAt: group[0]?.createdAt,
        executed,
        success,
        failed,
        status: failed > 0 ? "error" : "done",
      });
    } else {
      collapsed.push(...group);
    }

    index = cursor;
  }

  return collapsed;
};

const getToolStatusColor = (status: "running" | "done" | "error"): string => {
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord14;
};

const getToolHeaderTextColor = (
  status: "running" | "done" | "error",
): string => {
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord6;
};

const getToolCollapsedSummaryColor = (
  status: "running" | "done" | "error",
): string => {
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

const getToolLineTextColor = (line: ToolCardStyledLine): string => {
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

const getToolFieldColorsByTone = (
  tone: Extract<ToolCardStyledLine, { kind: "field" }>["tone"],
): { label: string; value: string } => {
  switch (tone) {
    case "error":
      return { label: NORD.nord11, value: NORD.nord11 };
    case "warning":
      return { label: NORD.nord8, value: NORD.nord6 };
    case "accent":
      return { label: NORD.nord9, value: NORD.nord8 };
    case "muted":
      return { label: NORD.nord3, value: NORD.nord4 };
    default:
      return { label: NORD.nord9, value: NORD.nord6 };
  }
};

const appendToolStyledBody = (
  renderer: CliRenderer,
  bodyWrap: BoxRenderable,
  item: Extract<ChatMessageCardInput, { role: "tool" }>,
) => {
  const lines = buildToolCardStyledLines(item);

  for (const line of lines) {
    if (line.kind === "spacer") {
      bodyWrap.add(
        new TextRenderable(renderer, {
          content: " ",
          fg: NORD.nord3,
          width: "100%",
        }),
      );
      continue;
    }

    if (line.kind === "field") {
      const colors = getToolFieldColorsByTone(line.tone);
      const row = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: NORD.nord0,
      });
      const labelText = new TextRenderable(renderer, {
        content: `${line.label}: `,
        fg: colors.label,
      });
      const valueText = new TextRenderable(renderer, {
        content: line.value,
        fg: colors.value,
        width: "100%",
        wrapMode: "char",
      });
      row.add(labelText);
      row.add(valueText);
      bodyWrap.add(row);
      continue;
    }

    bodyWrap.add(
      new TextRenderable(renderer, {
        content: line.text,
        fg: getToolLineTextColor(line),
        width: "100%",
        wrapMode: "char",
      }),
    );
  }
};

export const createMessagePaneView = (ctx: CliRenderer): MessagePaneView => {
  const box = new BoxRenderable(ctx, {
    border: true,
    borderStyle: "single",
    backgroundColor: NORD.nord0,
    paddingX: 1,
    width: "100%",
    flexDirection: "column",
    flexGrow: 1,
  });
  const topInsetText = new TextRenderable(ctx, {
    content: " ",
    fg: NORD.nord0,
    width: "100%",
    truncate: true,
  });
  const headerBar = new BoxRenderable(ctx, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    backgroundColor: NORD.nord2,
    paddingX: 0,
  });
  const headerText = new TextRenderable(ctx, {
    content: "Conversation",
    fg: NORD.nord4,
    width: "100%",
    truncate: true,
  });
  const headerDividerText = new TextRenderable(ctx, {
    content: "─".repeat(512),
    fg: NORD.nord1,
    width: "100%",
    truncate: true,
  });
  const subHeaderText = new TextRenderable(ctx, {
    content: "Ready",
    fg: NORD.nord3,
    width: "100%",
    truncate: true,
    visible: false,
  });
  const scroll = new ScrollBoxRenderable(ctx, {
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
  const listBox = new BoxRenderable(ctx, {
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
  const children = [...input.listBox.getChildren()];
  for (const child of children) {
    input.listBox.remove(child.id);
    if (!child.isDestroyed) child.destroyRecursively();
  }

  const renderItems = collapseCompletedToolGroups(input.items);

  if (renderItems.length === 0) {
    const emptyWrap = new BoxRenderable(input.renderer, {
      width: "100%",
      backgroundColor: NORD.nord0,
      paddingTop: 1,
    });
    const emptyText = new TextRenderable(input.renderer, {
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
    const cardState = buildChatMessageCardViewState(item);
    const isUser = cardState.role === "user";
    const isSystem = cardState.role === "system";
    const isAssistant = cardState.role === "assistant";
    const isTool = cardState.role === "tool";
    const isToolGroupSummary = cardState.role === "tool_group_summary";
    const isToolLike = isTool || isToolGroupSummary;
    const previousItem = index > 0 ? renderItems[index - 1] : undefined;
    const previousRole = previousItem?.role;
    const previousIsToolLike = previousRole === "tool" || previousRole === "tool_group_summary";
    const groupedPlainText =
      (isAssistant || isSystem) && previousRole === cardState.role;
    const toolMarginTop =
      isToolLike && previousItem ? (previousIsToolLike ? 0 : 1) : 0;
    const isCompactTool = isToolLike;
    const toolBorderEnabled = false;
    const cardBackgroundColor = isCompactTool
      ? NORD.nord0
      : isUser
        ? NORD.nord1
        : NORD.nord0;
    const card = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "row",
      marginTop:
        index === 0 ? 1 : isToolLike ? toolMarginTop : groupedPlainText ? 0 : 1,
      border: toolBorderEnabled,
      borderStyle: toolBorderEnabled ? "single" : undefined,
      borderColor:
        toolBorderEnabled && cardState.toolStatus === "error"
          ? NORD.nord11
          : toolBorderEnabled
            ? NORD.nord2
            : undefined,
      backgroundColor: cardBackgroundColor,
    });

    const bodyWrap = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "column",
      paddingLeft: isToolLike ? 0 : 1,
      paddingRight: 1,
      paddingTop: isToolLike ? 0 : isUser ? 1 : 0,
      paddingBottom: isToolLike ? 0 : isUser ? 1 : 0,
      backgroundColor: cardBackgroundColor,
    });

    const meta = cardState.metaText
      ? new TextRenderable(input.renderer, {
          content: cardState.metaText,
          fg: NORD.nord3,
          width: "100%",
          truncate: true,
        })
      : undefined;

    if (isToolLike) {
      const toolStatus = cardState.toolStatus ?? "done";
      // Compact tool row format contract:
      // "<status> [<toolName>] | <collapsed summary>"
      // Keep the trailing space after the status glyph so the symbol and tool name never touch.
      const statusMark =
        toolStatus === "error" ? "✕ " : toolStatus === "running" ? "… " : "✓ ";
      const collapsedSummary = isTool
        ? buildToolCardCollapsedSummary(item as Extract<ChatMessageCardInput, { role: "tool" }>)
        : isToolGroupSummary
          ? buildToolGroupCollapsedSummaryText(item as ToolGroupSummaryCardInput)
          : undefined;

      const titleRow = new BoxRenderable(input.renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: cardBackgroundColor,
        paddingLeft: 1,
      });
      const titleStatusText = new TextRenderable(input.renderer, {
        content: `${statusMark} `,
        fg: getToolStatusColor(toolStatus),
      });
      const titlePrefixText = new TextRenderable(input.renderer, {
        content: `[${cardState.titleText ?? "tool"}]`,
        fg: isToolGroupSummary ? getToolStatusColor(toolStatus) : NORD.nord4,
      });
      titleRow.add(titleStatusText);
      titleRow.add(titlePrefixText);

      if (collapsedSummary) {
        const titleSummaryText = new TextRenderable(input.renderer, {
          content: ` ${collapsedSummary}`,
          fg: isToolGroupSummary
            ? getToolStatusColor(toolStatus)
            : getToolCollapsedSummaryColor(toolStatus),
          width: "100%",
          truncate: true,
        });
        titleRow.add(titleSummaryText);
      } else {
        const titleSpacer = new TextRenderable(input.renderer, {
          content: " ",
          fg: NORD.nord3,
          width: "100%",
        });
        titleRow.add(titleSpacer);
      }
      bodyWrap.add(titleRow);
    } else {
      if (cardState.role === "assistant") {
        const markdown = new MarkdownRenderable(input.renderer, {
          content: cardState.bodyText ?? " ",
          syntaxStyle: ASSISTANT_MARKDOWN_SYNTAX_STYLE,
          conceal: true,
          streaming: false,
          width: "100%",
        });
        bodyWrap.add(markdown);
      } else {
        const bodyText = new TextRenderable(input.renderer, {
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
      const accent = new BoxRenderable(input.renderer, {
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
