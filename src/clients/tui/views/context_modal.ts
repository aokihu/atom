import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";
import type { TerminalSize } from "../layout/metrics";
import { truncateToDisplayWidth } from "../utils/text";

export type ContextModalLayoutInput = {
  terminal: TerminalSize;
  title: string;
  body: string;
};

export type ContextModalLayoutState = {
  width: number;
  height: number;
  top: number;
  left: number;
  innerWidth: number;
  titleText: string;
  hintText: string;
  scrollHeight: number;
  bodyText: string;
};

export type ContextModalView = {
  overlay: BoxRenderable;
  backdrop: BoxRenderable;
  modalBox: BoxRenderable;
  titleText: TextRenderable;
  hintText: TextRenderable;
  scroll: ScrollBoxRenderable;
  contentBox: BoxRenderable;
  bodyText: TextRenderable;
};

export const createContextModalView = (ctx: CliRenderer): ContextModalView => {
  const overlay = new BoxRenderable(ctx, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 60,
    visible: false,
    backgroundColor: "transparent",
  });
  const backdrop = new BoxRenderable(ctx, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: NORD.nord0,
    opacity: 0.55,
  });
  const modalBox = new BoxRenderable(ctx, {
    position: "absolute",
    top: 2,
    left: 2,
    width: 80,
    height: 20,
    border: true,
    borderStyle: "single",
    borderColor: NORD.nord8,
    backgroundColor: NORD.nord1,
    paddingX: 1,
    flexDirection: "column",
    zIndex: 61,
  });
  const titleText = new TextRenderable(ctx, {
    content: "Context",
    fg: NORD.nord8,
    width: "100%",
    truncate: true,
  });
  const hintText = new TextRenderable(ctx, {
    content: "Esc close · Arrow/Page keys scroll",
    fg: NORD.nord3,
    width: "100%",
    truncate: true,
  });
  const scroll = new ScrollBoxRenderable(ctx, {
    width: "100%",
    height: 1,
    scrollX: false,
    scrollY: true,
    rootOptions: { backgroundColor: NORD.nord1 },
    wrapperOptions: { backgroundColor: NORD.nord1 },
    viewportOptions: { backgroundColor: NORD.nord1 },
    contentOptions: { backgroundColor: NORD.nord1 },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: NORD.nord3,
        backgroundColor: NORD.nord2,
      },
    },
  });
  const contentBox = new BoxRenderable(ctx, {
    width: "100%",
    backgroundColor: NORD.nord1,
  });
  const bodyText = new TextRenderable(ctx, {
    content: "No context loaded.",
    fg: NORD.nord4,
    width: "100%",
    wrapMode: "char",
  });

  contentBox.add(bodyText);
  scroll.add(contentBox);
  modalBox.add(titleText);
  modalBox.add(hintText);
  modalBox.add(scroll);
  overlay.add(backdrop);
  overlay.add(modalBox);

  return {
    overlay,
    backdrop,
    modalBox,
    titleText,
    hintText,
    scroll,
    contentBox,
    bodyText,
  };
};

export const buildContextModalLayoutState = (input: ContextModalLayoutInput): ContextModalLayoutState => {
  const width = Math.max(40, Math.min(110, input.terminal.columns - 8));
  const height = Math.max(10, Math.min(input.terminal.rows - 6, Math.floor(input.terminal.rows * 0.65)));
  const top = Math.max(1, Math.floor((input.terminal.rows - height) / 2));
  const left = Math.max(1, Math.floor((input.terminal.columns - width) / 2));
  const innerWidth = Math.max(1, width - 4);

  return {
    width,
    height,
    top,
    left,
    innerWidth,
    titleText: truncateToDisplayWidth(input.title, innerWidth),
    hintText: truncateToDisplayWidth("Esc close · Arrow/Page keys scroll", innerWidth),
    scrollHeight: Math.max(1, height - 4),
    bodyText: input.body.length > 0 ? input.body : "No context loaded.",
  };
};
