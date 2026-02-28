import { Box, ScrollBox, Text, instantiate } from "@opentui/core";
import type {
  BoxRenderable,
  CliRenderer,
  KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { effect, signal } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

import type { TerminalSize } from "../layout/metrics";
import type { TuiTheme } from "../theme";
import { truncateToDisplayWidth } from "../utils/text";

export type ScheduleModalLayoutInput = {
  terminal: TerminalSize;
  title: string;
  body: string;
};

export type ScheduleModalLayoutState = {
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

export type ScheduleModalView = {
  overlay: BoxRenderable;
  backdrop: BoxRenderable;
  modalBox: BoxRenderable;
  titleText: TextRenderable;
  hintText: TextRenderable;
  scroll: ScrollBoxRenderable;
  contentBox: BoxRenderable;
  bodyText: TextRenderable;
};

export type ScheduleModalRenderInput = {
  open: boolean;
  terminal: TerminalSize;
  title: string;
  body: string;
};

export type ScheduleModalViewController = {
  readonly view: ScheduleModalView;
  syncFromAppState: (input: ScheduleModalRenderInput) => void;
  open: (args: { terminal: TerminalSize; title: string; body: string }) => void;
  close: () => void;
  isOpen: () => boolean;
  handleKey: (key: KeyEvent) => boolean;
  scrollTop: () => void;
  focus: () => void;
  blur: () => void;
  dispose: () => void;
};

export const buildScheduleModalLayoutState = (
  input: ScheduleModalLayoutInput,
): ScheduleModalLayoutState => {
  const width = Math.max(40, Math.min(110, input.terminal.columns - 8));
  const height = Math.max(
    10,
    Math.min(input.terminal.rows - 6, Math.floor(input.terminal.rows * 0.65)),
  );
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
    hintText: truncateToDisplayWidth(
      "Esc close · Arrow/Page keys scroll",
      innerWidth,
    ),
    scrollHeight: Math.max(1, height - 4),
    bodyText: input.body.length > 0 ? input.body : "No schedules.",
  };
};

export const createScheduleModalView = (
  ctx: CliRenderer,
  theme: TuiTheme,
): ScheduleModalView => {
  const C = theme.colors;

  const overlay = instantiate(
    ctx,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 70,
      visible: false,
      backgroundColor: "transparent",
    }),
  ) as unknown as BoxRenderable;

  const backdrop = instantiate(
    ctx,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: C.overlayScrim,
      opacity: 0.55,
    }),
  ) as unknown as BoxRenderable;

  const modalBox = instantiate(
    ctx,
    Box({
      position: "absolute",
      top: 2,
      left: 2,
      width: 80,
      height: 20,
      border: true,
      borderStyle: "single",
      borderColor: C.borderAccentPrimary,
      backgroundColor: C.panelBackgroundAlt,
      paddingX: 1,
      flexDirection: "column",
      zIndex: 71,
    }),
  ) as unknown as BoxRenderable;

  const titleText = instantiate(
    ctx,
    Text({
      content: "Schedules",
      fg: C.accentPrimary,
      width: "100%",
      truncate: true,
    }),
  ) as unknown as TextRenderable;

  const hintText = instantiate(
    ctx,
    Text({
      content: "Esc close · Arrow/Page keys scroll",
      fg: C.textMuted,
      width: "100%",
      truncate: true,
    }),
  ) as unknown as TextRenderable;

  const scroll = instantiate(
    ctx,
    ScrollBox({
      width: "100%",
      height: 1,
      scrollX: false,
      scrollY: true,
      rootOptions: { backgroundColor: C.panelBackgroundAlt },
      wrapperOptions: { backgroundColor: C.panelBackgroundAlt },
      viewportOptions: { backgroundColor: C.panelBackgroundAlt },
      contentOptions: { backgroundColor: C.panelBackgroundAlt },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: C.scrollbarThumb,
          backgroundColor: C.scrollbarTrack,
        },
      },
    }),
  ) as unknown as ScrollBoxRenderable;

  const contentBox = instantiate(
    ctx,
    Box({
      width: "100%",
      backgroundColor: C.panelBackgroundAlt,
    }),
  ) as unknown as BoxRenderable;

  const bodyText = instantiate(
    ctx,
    Text({
      content: "No schedules.",
      fg: C.textSecondary,
      width: "100%",
      wrapMode: "char",
    }),
  ) as unknown as TextRenderable;

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

export const updateScheduleModalView = (args: {
  view: ScheduleModalView;
  input: ScheduleModalRenderInput;
}): void => {
  const { view, input } = args;
  view.overlay.visible = input.open;
  if (!input.open) return;

  const state = buildScheduleModalLayoutState({
    terminal: input.terminal,
    title: input.title,
    body: input.body,
  });

  view.modalBox.width = state.width;
  view.modalBox.height = state.height;
  view.modalBox.top = state.top;
  view.modalBox.left = state.left;

  view.titleText.content = state.titleText;
  view.hintText.content = state.hintText;
  view.scroll.height = state.scrollHeight;
  view.bodyText.content = state.bodyText;
};

export const bindScheduleModalViewModel = (args: {
  view: ScheduleModalView;
  inputSignal: ReadonlySignal<ScheduleModalRenderInput | null>;
  isDestroyed?: () => boolean;
}): (() => void) => effect(() => {
  if (args.isDestroyed?.()) return;
  const input = args.inputSignal.value;
  if (!input) return;
  updateScheduleModalView({
    view: args.view,
    input,
  });
});

const isEscapeKey = (key: KeyEvent): boolean => {
  if (key.name === "escape" || key.name === "esc") return true;
  if (key.code === "Escape") return true;
  if (key.baseCode === 27) return true;
  if (key.raw === "\u001b" || key.sequence === "\u001b") return true;
  return false;
};

export const createScheduleModalViewController = (args: {
  ctx?: CliRenderer;
  theme: TuiTheme;
  view?: ScheduleModalView;
  isDestroyed?: () => boolean;
}): ScheduleModalViewController => {
  const view = args.view ?? (() => {
    if (!args.ctx) {
      throw new Error("createScheduleModalViewController requires args.ctx when args.view is not provided");
    }
    return createScheduleModalView(args.ctx, args.theme);
  })();

  const renderInputSignal = signal<ScheduleModalRenderInput | null>(null);
  const disposeSync = bindScheduleModalViewModel({
    view,
    inputSignal: renderInputSignal,
    isDestroyed: args.isDestroyed,
  });

  return {
    view,
    syncFromAppState: (input) => {
      renderInputSignal.value = input;
    },
    open: ({ terminal, title, body }) => {
      renderInputSignal.value = {
        open: true,
        terminal,
        title,
        body,
      };
    },
    close: () => {
      const current = renderInputSignal.value;
      if (!current) return;
      renderInputSignal.value = {
        ...current,
        open: false,
      };
    },
    isOpen: () => Boolean(renderInputSignal.value?.open),
    handleKey: (key) => isEscapeKey(key),
    scrollTop: () => {
      try {
        view.scroll.scrollTo(0);
      } catch {
        // noop
      }
    },
    focus: () => {
      try {
        view.scroll.focus();
      } catch {
        // noop
      }
    },
    blur: () => {
      try {
        view.scroll.blur();
      } catch {
        // noop
      }
    },
    dispose: () => {
      disposeSync();
    },
  };
};
