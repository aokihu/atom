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

export type ChatMessageCardInput = {
  role: "user" | "assistant" | "system";
  text: string;
  taskId?: string;
} | {
  role: "tool";
  toolName: string;
  callSummary?: string;
  resultSummary?: string;
  errorMessage?: string;
  callDisplay?: ToolDisplayEnvelope;
  resultDisplay?: ToolDisplayEnvelope;
  collapsed: boolean;
  status: "running" | "done" | "error";
  taskId?: string;
};

export type ChatMessageCardViewState = {
  role: ChatMessageCardInput["role"];
  titleText?: string;
  bodyText?: string;
  metaText: string;
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

const getToolStatusColor = (status: "running" | "done" | "error"): string => {
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord14;
};

const getToolHeaderTextColor = (status: "running" | "done" | "error"): string => {
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord8;
  return NORD.nord6;
};

const getToolCollapsedSummaryColor = (status: "running" | "done" | "error"): string => {
  if (status === "error") return NORD.nord11;
  if (status === "running") return NORD.nord4;
  return NORD.nord4;
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
    borderColor: NORD.nord3,
    backgroundColor: NORD.nord0,
    paddingX: 1,
    width: "100%",
    flexDirection: "column",
    flexGrow: 1,
  });
  const headerText = new TextRenderable(ctx, {
    content: "Conversation",
    fg: NORD.nord8,
    width: "100%",
    truncate: true,
  });
  const subHeaderText = new TextRenderable(ctx, {
    content: "Ready",
    fg: NORD.nord3,
    width: "100%",
    truncate: true,
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
  box.add(headerText);
  box.add(subHeaderText);
  box.add(scroll);

  return {
    box,
    headerText,
    subHeaderText,
    scroll,
    listBox,
  };
};

export const buildMessageHeaderLine = (agentName: string, count: number, width: number): string => {
  return truncateToDisplayWidth(`${agentName} Conversation • ${count} messages`, width);
};

export const buildMessageSubHeaderLine = (args: MessagePaneSubHeaderInput): string => {
  void args;
  return " ";
};

export const buildChatMessageCardViewState = (item: ChatMessageCardInput): ChatMessageCardViewState => {
  if (item.role === "tool") {
    return {
      role: "tool",
      titleText: item.toolName.length > 0 ? `[Tool] ${item.toolName}` : "[Tool]",
      toolCollapsed: item.collapsed,
      toolStatus: item.status,
      metaText: `tool${item.taskId ? ` • ${item.taskId}` : ""}`,
    };
  }

  const isUser = item.role === "user";
  const isSystem = item.role === "system";
  return {
    role: item.role,
    bodyText: item.text.length > 0 ? item.text : " ",
    metaText: isUser
      ? `user${item.taskId ? ` • ${item.taskId}` : ""}`
      : isSystem
        ? `system${item.taskId ? ` • ${item.taskId}` : ""}`
        : "assistant",
  };
};

export const renderMessageStreamContent = (input: RenderMessageStreamInput): void => {
  const children = [...input.listBox.getChildren()];
  for (const child of children) {
    input.listBox.remove(child.id);
    if (!child.isDestroyed) child.destroyRecursively();
  }

  if (input.items.length === 0) {
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

  for (const [index, item] of input.items.entries()) {
    const cardState = buildChatMessageCardViewState(item);
    const isUser = cardState.role === "user";
    const isSystem = cardState.role === "system";
    const isTool = cardState.role === "tool";
    const isCollapsedTool = isTool && item.role === "tool" && item.collapsed;
    const previousItem = index > 0 ? input.items[index - 1] : undefined;
    const toolMarginTop = isTool && previousItem ? 1 : 0;
    const toolBorderEnabled = isTool && !isCollapsedTool;
    const cardBackgroundColor = isCollapsedTool ? NORD.nord1 : isUser ? NORD.nord1 : NORD.nord0;
    const card = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "row",
      marginTop: isTool ? toolMarginTop : 1,
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
      paddingLeft: isTool ? (isCollapsedTool ? 1 : 2) : 1,
      paddingRight: 1,
      paddingTop: isTool ? 0 : 1,
      paddingBottom: isCollapsedTool ? 0 : isTool ? 0 : 1,
      backgroundColor: cardBackgroundColor,
    });

    const meta = new TextRenderable(input.renderer, {
      content: cardState.metaText,
      fg: NORD.nord3,
      width: "100%",
      truncate: true,
    });

    if (isTool) {
      const toolItem = item as Extract<ChatMessageCardInput, { role: "tool" }>;
      const toolStatus = cardState.toolStatus ?? "done";
      const collapseMark = cardState.toolCollapsed ? "▶" : "▼";
      const statusMark = toolStatus === "error" ? "✕" : toolStatus === "running" ? "…" : "✓";
      const collapsedSummary =
        cardState.toolCollapsed ? buildToolCardCollapsedSummary(toolItem) : undefined;
      if (isCollapsedTool) {
        const toolAccent = new BoxRenderable(input.renderer, {
          width: 1,
          border: ["left"],
          borderStyle: "single",
          borderColor: getToolStatusColor(toolStatus),
          shouldFill: false,
          backgroundColor: cardBackgroundColor,
        });
        card.add(toolAccent);
      }

      const titleRow = new BoxRenderable(input.renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: cardBackgroundColor,
      });
      const titlePrefixText = new TextRenderable(input.renderer, {
        content: `${collapseMark} ${cardState.titleText ?? "[Tool]"} ${statusMark}`,
        fg: getToolHeaderTextColor(toolStatus),
      });
      titleRow.add(titlePrefixText);

      if (collapsedSummary) {
        const titleSummaryText = new TextRenderable(input.renderer, {
          content: ` • ${collapsedSummary}`,
          fg: getToolCollapsedSummaryColor(toolStatus),
          width: "100%",
          wrapMode: "char",
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

      if (!cardState.toolCollapsed) {
        bodyWrap.add(
          new TextRenderable(input.renderer, {
            content: cardState.metaText,
            fg: NORD.nord3,
            width: "100%",
            truncate: true,
          }),
        );
        appendToolStyledBody(
          input.renderer,
          bodyWrap,
          toolItem,
        );
      }
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
          fg: isUser ? NORD.nord5 : NORD.nord8,
          width: "100%",
          wrapMode: "char",
        });
        bodyWrap.add(bodyText);
      }
    }

    if (!isTool) {
      bodyWrap.add(meta);
    }
    if (!isTool) {
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
