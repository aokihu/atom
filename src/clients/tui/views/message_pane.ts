import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";
import { truncateToDisplayWidth } from "../utils/text";

export type MessagePaneSubHeaderInput = {
  phase: "idle" | "submitting" | "polling";
  connection: "unknown" | "ok" | "error";
  taskId?: string;
  focus: "input" | "answer";
  agentName: string;
  spinnerFrame: string;
  width: number;
};

export type ChatMessageCardInput = {
  role: "user" | "assistant";
  text: string;
  taskId?: string;
};

export type ChatMessageCardViewState = {
  isUser: boolean;
  bodyText: string;
  metaText: string;
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
  const busy =
    args.phase === "idle"
      ? "idle"
      : args.phase === "submitting"
        ? `${args.spinnerFrame} sending`
        : `${args.spinnerFrame} ${args.agentName} generating`;

  return truncateToDisplayWidth(
    `conn:${args.connection}  state:${args.phase}  busy:${busy}${args.taskId ? `  task:${args.taskId}` : ""}  focus:${args.focus}`,
    args.width,
  );
};

export const buildChatMessageCardViewState = (item: ChatMessageCardInput): ChatMessageCardViewState => {
  const isUser = item.role === "user";
  return {
    isUser,
    bodyText: item.text.length > 0 ? item.text : " ",
    metaText: `${isUser ? "user" : "assistant"}${item.taskId ? ` • ${item.taskId}` : ""}`,
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
    const isUser = cardState.isUser;
    const card = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "row",
      marginTop: 1,
      backgroundColor: isUser ? NORD.nord1 : NORD.nord0,
    });

    const accent = new BoxRenderable(input.renderer, {
      width: 1,
      backgroundColor: isUser ? NORD.nord9 : NORD.nord3,
    });

    const bodyWrap = new BoxRenderable(input.renderer, {
      width: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      paddingBottom: 0,
      backgroundColor: isUser ? NORD.nord1 : NORD.nord0,
    });

    const bodyText = new TextRenderable(input.renderer, {
      content: cardState.bodyText,
      fg: isUser ? NORD.nord5 : NORD.nord4,
      width: "100%",
      wrapMode: "char",
    });

    const meta = new TextRenderable(input.renderer, {
      content: cardState.metaText,
      fg: NORD.nord3,
      width: "100%",
      truncate: true,
    });

    bodyWrap.add(bodyText);
    bodyWrap.add(meta);
    card.add(accent);
    card.add(bodyWrap);
    input.listBox.add(card);
  }
};
