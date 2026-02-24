import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";
import { truncateToDisplayWidth } from "../utils/text";

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
  title: string;
  body?: string;
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
      titleText: item.title.length > 0 ? item.title : "[Tool]",
      bodyText: item.body && item.body.length > 0 ? item.body : undefined,
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

  for (const item of input.items) {
    const cardState = buildChatMessageCardViewState(item);
    const isUser = cardState.role === "user";
    const isSystem = cardState.role === "system";
    const isTool = cardState.role === "tool";
    const card = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "row",
      marginTop: 1,
      border: isTool,
      borderStyle: isTool ? "single" : undefined,
      borderColor:
        isTool && cardState.toolStatus === "error"
          ? NORD.nord11
          : isTool
            ? NORD.nord3
            : undefined,
      backgroundColor: isUser ? NORD.nord1 : NORD.nord0,
    });

    const bodyWrap = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "column",
      paddingLeft: isTool ? 2 : 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: isUser ? NORD.nord1 : NORD.nord0,
    });

    const meta = new TextRenderable(input.renderer, {
      content: cardState.metaText,
      fg: NORD.nord3,
      width: "100%",
      truncate: true,
    });

    if (isTool) {
      const bodyText = new TextRenderable(input.renderer, {
        content: cardState.bodyText ?? " ",
        fg: NORD.nord6,
        width: "100%",
        wrapMode: "char",
      });
      const collapseMark = cardState.toolCollapsed ? "[+]" : "[-]";
      const statusMark =
        cardState.toolStatus === "error"
          ? "[fail]"
          : cardState.toolStatus === "running"
            ? "[running]"
            : "[success]";
      const titleText = new TextRenderable(input.renderer, {
        content: `${collapseMark} ${cardState.titleText ?? "[Tool]"} ${statusMark}`,
        fg:
          cardState.toolStatus === "error"
            ? NORD.nord11
            : cardState.toolStatus === "running"
              ? NORD.nord8
              : NORD.nord6,
        width: "100%",
        wrapMode: "char",
      });
      bodyWrap.add(titleText);

      if (!cardState.toolCollapsed && cardState.bodyText) {
        bodyWrap.add(bodyText);
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
        backgroundColor: isUser ? NORD.nord9 : isSystem ? NORD.nord8 : NORD.nord3,
      });
      card.add(accent);
    }
    card.add(bodyWrap);
    input.listBox.add(card);
  }
};
