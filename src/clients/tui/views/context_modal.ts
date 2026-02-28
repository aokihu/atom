/**
 * TUI 组件：Context Modal（上下文详情弹层）
 * 用于何处：被 `src/clients/tui/runtime/ui.ts` 装配，并由 `CoreTuiClientApp` 在查看上下文内容时打开。
 * 主要职责：构建弹层节点树（标题/提示/滚动正文）以及根据终端尺寸计算弹层布局。
 *
 * ASCII Layout
 * +---------------------- overlay (full screen) -----------------------+
 * | +------------------- backdrop / scrim ---------------------------+  |
 * | +---------------------------------------------------------------+  |
 * |      +-------------------- modalBox ---------------------+         |
 * |      | titleText                                         |         |
 * |      | hintText (Esc / scroll hint)                      |         |
 * |      | +--------------- scroll ------------------------+ |         |
 * |      | | contentBox -> bodyText                        | |         |
 * |      | +----------------------------------------------+ |         |
 * |      +--------------------------------------------------+         |
 * +-------------------------------------------------------------------+
 */
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

// ================================
// 类型定义区
// ================================

export type ContextModalLayoutInput = {
  terminal: TerminalSize;
  title: string;
  body: string;
  saveStatus?: string;
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
  saveActionText: string;
};

export type ContextModalView = {
  overlay: BoxRenderable;
  backdrop: BoxRenderable;
  modalBox: BoxRenderable;
  titleText: TextRenderable;
  hintText: TextRenderable;
  saveActionText: TextRenderable;
  scroll: ScrollBoxRenderable;
  contentBox: BoxRenderable;
  bodyText: TextRenderable;
};

export type ContextModalRenderInput = {
  open: boolean;
  terminal: TerminalSize;
  title: string;
  body: string;
  saveStatus?: string;
};

export type ContextModalViewController = {
  readonly view: ContextModalView;
  syncFromAppState: (input: ContextModalRenderInput) => void;
  open: (args: { terminal: TerminalSize; title: string; body: string }) => void;
  close: () => void;
  isOpen: () => boolean;
  handleKey: (key: KeyEvent) => boolean;
  scrollTop: () => void;
  focus: () => void;
  blur: () => void;
  dispose: () => void;
};

// ================================
// 逻辑计算区（布局与文案）
// ================================

export const buildContextModalLayoutState = (
  input: ContextModalLayoutInput,
): ContextModalLayoutState => {
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
      "Esc close · S save · Arrow/Page keys scroll",
      innerWidth,
    ),
    scrollHeight: Math.max(1, height - 5),
    bodyText: input.body.length > 0 ? input.body : "No context loaded.",
    saveActionText: truncateToDisplayWidth(
      input.saveStatus?.trim()
        ? `[ Save Context ]  ${input.saveStatus.trim()}`
        : "[ Save Context ]",
      innerWidth,
    ),
  };
};

// ================================
// UI 渲染区（Constructs 节点树）
// ================================

export const createContextModalView = (
  ctx: CliRenderer,
  theme: TuiTheme,
  options?: { onSaveClick?: () => void },
): ContextModalView => {
  const C = theme.colors;

  // UI 渲染区：全屏 overlay + 遮罩 + 弹窗主体
  const overlay = instantiate(
    ctx,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 60,
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

  // 部件说明：弹窗主体容器，承载标题、提示和滚动内容区。
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
      borderColor: C.borderAccentSecondary,
      backgroundColor: C.panelBackgroundAlt,
      paddingX: 1,
      flexDirection: "column",
      zIndex: 61,
    }),
  ) as unknown as BoxRenderable;

  // UI 渲染区：标题/提示行 + 可滚动内容区
  const titleText = instantiate(
    ctx,
    Text({
      content: "Context",
      fg: C.accentPrimary,
      width: "100%",
      truncate: true,
    }),
  ) as unknown as TextRenderable;

  // 部件说明：操作提示文本（关闭与滚动快捷键说明）。
  const hintText = instantiate(
    ctx,
    Text({
      content: "Esc close · S save · Arrow/Page keys scroll",
      fg: C.textMuted,
      width: "100%",
      truncate: true,
    }),
  ) as unknown as TextRenderable;

  const saveActionText = instantiate(
    ctx,
    Text({
      content: "[ Save Context ]",
      fg: C.accentPrimary,
      width: "100%",
      truncate: true,
      onMouseUp: (event: { button: number }) => {
        if (event.button === 0) {
          options?.onSaveClick?.();
        }
      },
    }),
  ) as unknown as TextRenderable;

  // 部件说明：滚动容器，负责上下文长文本的纵向滚动与滚动条显示。
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

  // 部件说明：滚动内容根容器，便于后续扩展为多段内容节点。
  const contentBox = instantiate(
    ctx,
    Box({
      width: "100%",
      backgroundColor: C.panelBackgroundAlt,
    }),
  ) as unknown as BoxRenderable;

  // 部件说明：正文文本节点（显示完整上下文内容）。
  const bodyText = instantiate(
    ctx,
    Text({
      content: "No context loaded.",
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
  modalBox.add(saveActionText);
  overlay.add(backdrop);
  overlay.add(modalBox);

  return {
    overlay,
    backdrop,
    modalBox,
    titleText,
    hintText,
    saveActionText,
    scroll,
    contentBox,
    bodyText,
  };
};

// ================================
// 运行时注入区（将实时状态数据注入组件）
// ================================

export const updateContextModalView = (
  args: {
    view: ContextModalView;
    input: ContextModalRenderInput;
  },
): void => {
  const { view, input } = args;
  view.overlay.visible = input.open;
  if (!input.open) return;

  const viewState = buildContextModalLayoutState({
    terminal: input.terminal,
    title: input.title,
    body: input.body,
    saveStatus: input.saveStatus,
  });

  view.modalBox.width = viewState.width;
  view.modalBox.height = viewState.height;
  view.modalBox.top = viewState.top;
  view.modalBox.left = viewState.left;
  view.titleText.content = viewState.titleText;
  view.hintText.content = viewState.hintText;
  view.scroll.height = viewState.scrollHeight;
  view.bodyText.content = viewState.bodyText;
  view.saveActionText.content = viewState.saveActionText;
};

// ================================
// 响应式绑定区（Signal -> 视图同步）
// ================================

export const bindContextModalViewModel = (
  args: {
    view: ContextModalView;
    inputSignal: ReadonlySignal<ContextModalRenderInput | null>;
    isDestroyed?: () => boolean;
  },
): (() => void) => effect(() => {
  if (args.isDestroyed?.()) return;
  const input = args.inputSignal.value;
  if (!input) return;
  updateContextModalView({
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

export const createContextModalViewController = (
  args: {
    ctx?: CliRenderer;
    theme: TuiTheme;
    view?: ContextModalView;
    isDestroyed?: () => boolean;
    onSaveClick?: () => void;
  },
): ContextModalViewController => {
  const view = args.view ?? (() => {
    if (!args.ctx) {
      throw new Error("createContextModalViewController requires args.ctx when args.view is not provided");
    }
    return createContextModalView(args.ctx, args.theme, {
      onSaveClick: args.onSaveClick,
    });
  })();
  const renderInputSignal = signal<ContextModalRenderInput | null>(null);
  const disposeSync = bindContextModalViewModel({
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
        saveStatus: "",
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
