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
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";

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
      "Esc close · Arrow/Page keys scroll",
      innerWidth,
    ),
    scrollHeight: Math.max(1, height - 4),
    bodyText: input.body.length > 0 ? input.body : "No context loaded.",
  };
};

// ================================
// UI 渲染区（Constructs 节点树）
// ================================

export const createContextModalView = (
  ctx: CliRenderer,
  theme: TuiTheme,
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
      content: "Esc close · Arrow/Page keys scroll",
      fg: C.textMuted,
      width: "100%",
      truncate: true,
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
