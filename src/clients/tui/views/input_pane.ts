/**
 * TUI 组件：Input Pane（输入面板）
 * 用于何处：被 `src/clients/tui/runtime/ui.ts` 装配在主界面底部，由 `CoreTuiClientApp` 持续更新输入框状态/提示文案。
 * 主要职责：构建输入区域节点树（rail、hint、textarea）并生成输入态对应的展示文案。
 *
 * ASCII Layout
 * +-------------------------------------------------------------------+
 * | railBox | mainBox                                                 |
 * |         | +-----------------------------------------------------+ |
 * |         | | hintText (notice / shortcut line)                   | |
 * |         | +-----------------------------------------------------+ |
 * |         | | editorHost -> textarea                              | |
 * |         | +-----------------------------------------------------+ |
 * +-------------------------------------------------------------------+
 */
import { Box, Text, TextareaRenderable, h, instantiate } from "@opentui/core";
import type {
  BoxRenderable,
  CliRenderer,
  TextRenderable,
  TextareaRenderable as TextareaRenderableType,
} from "@opentui/core";

import type { TuiTheme } from "../theme";

// ================================
// 类型定义区
// ================================

export type InputPaneViewInput = {
  isBusy: boolean;
  inputFocused: boolean;
  busyIndicator?: string;
  agentName: string;
  noticeText?: string;
};

export type InputPaneViewState = {
  placeholderText: string;
  hintText: string;
  showHint: boolean;
  railAccentColor: "focused" | "idle";
};

export type InputPaneView = {
  box: BoxRenderable;
  railBox: BoxRenderable;
  railAccent: BoxRenderable;
  railAccentGlyph: TextRenderable;
  railTextUser: TextRenderable;
  railTextInput: TextRenderable;
  mainBox: BoxRenderable;
  hintText: TextRenderable;
  editorHost: BoxRenderable;
  textarea: TextareaRenderableType;
};

// ================================
// UI 渲染辅助区（Constructs -> Renderable）
// ================================

const mountBox = (
  ctx: CliRenderer,
  props: Parameters<typeof Box>[0],
  ...children: any[]
): BoxRenderable =>
  instantiate(ctx, Box(props, ...children)) as unknown as BoxRenderable;

const mountText = (
  ctx: CliRenderer,
  props: Parameters<typeof Text>[0],
): TextRenderable => instantiate(ctx, Text(props)) as unknown as TextRenderable;

const mountTextarea = (
  ctx: CliRenderer,
  props: ConstructorParameters<typeof TextareaRenderable>[1],
): TextareaRenderableType =>
  instantiate(
    ctx,
    h(TextareaRenderable, props),
  ) as unknown as TextareaRenderableType;

// ================================
// 导出接口区（组件构建）
// ================================

export const createInputPaneView = (
  ctx: CliRenderer,
  theme: TuiTheme,
  args: {
    keyBindings: any[];
    onSubmit: () => void;
  },
): InputPaneView => {
  const C = theme.colors;

  // UI 渲染区：左侧 rail（身份/模式提示） + 右侧编辑区
  const box = mountBox(ctx, {
    border: false,
    backgroundColor: C.panelBackgroundAlt,
    paddingX: 1,
    paddingY: 1,
    width: "100%",
    flexDirection: "row",
  });

  const railBox = mountBox(ctx, {
    width: 12,
    height: "100%",
    flexDirection: "row",
    backgroundColor: C.panelBackgroundAlt,
  });
  // 部件说明：左侧竖向高亮轨道容器，用来承载光标强调和身份文字列。
  const railAccent = mountBox(ctx, {
    width: 1,
    height: "100%",
    flexDirection: "column",
    backgroundColor: C.panelBackgroundAlt,
  });
  // 部件说明：轨道高亮字符（根据 focus 状态切换颜色，形成视觉焦点）。
  const railAccentGlyph = mountText(ctx, {
    content: "▎",
    fg: C.accentSecondary,
    width: 1,
  });
  // 部件说明：rail 文本容器，垂直居中显示身份/输入模式文案。
  const railTextBox = mountBox(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    paddingLeft: 1,
    backgroundColor: C.panelBackgroundAlt,
  });
  // 部件说明：用户侧标签文本（按需显示）。
  const railTextUser = mountText(ctx, {
    content: " ",
    fg: C.accentSecondary,
    width: "100%",
    truncate: true,
    visible: false,
  });
  // 部件说明：输入状态标签文本（按需显示）。
  const railTextInput = mountText(ctx, {
    content: " ",
    fg: C.textSecondary,
    width: "100%",
    truncate: true,
    visible: false,
  });
  railTextBox.add(railTextUser);
  railTextBox.add(railTextInput);
  railAccent.add(railAccentGlyph);
  railBox.add(railAccent);

  // UI 渲染区：右侧主区域 = hint 行 + textarea 宿主区
  const mainBox = mountBox(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: C.panelBackgroundAlt,
  });
  // 部件说明：顶部提示行（显示 notice / 快捷操作提示，内容为空时隐藏）。
  const hintText = mountText(ctx, {
    content: "",
    fg: C.textSecondary,
    width: "100%",
    truncate: true,
  });
  // 部件说明：编辑器宿主容器，主要用于后续按布局动态调整高度。
  const editorHost = mountBox(ctx, {
    width: "100%",
    height: 1,
    backgroundColor: C.panelBackgroundAlt,
  });
  // 部件说明：实际输入控件，负责文本编辑、换行和提交事件。
  const textarea = mountTextarea(ctx, {
    width: "100%",
    height: "100%",
    initialValue: "",
    backgroundColor: C.panelBackgroundAlt,
    focusedBackgroundColor: C.selectionBackground,
    textColor: C.inputText,
    focusedTextColor: C.inputTextFocused,
    placeholderColor: C.inputPlaceholder,
    wrapMode: "word",
    keyBindings: args.keyBindings,
    onSubmit: args.onSubmit,
  });

  mainBox.add(hintText);
  editorHost.add(textarea);
  mainBox.add(editorHost);

  box.add(railBox);
  box.add(mainBox);

  return {
    box,
    railBox,
    railAccent,
    railAccentGlyph,
    railTextUser,
    railTextInput,
    mainBox,
    hintText,
    editorHost,
    textarea,
  };
};

// ================================
// 逻辑计算区（纯状态 -> 文案/展示状态）
// ================================

export const buildInputPaneViewState = (
  input: InputPaneViewInput,
): InputPaneViewState => {
  const placeholderText = input.isBusy
    ? `${input.busyIndicator ?? "Task in progress..."} (input locked)`
    : `Ask ${input.agentName} · Enter=submit · Shift+Enter=newline · /=commands`;

  const hintText = input.noticeText?.trim() ?? "";

  return {
    placeholderText,
    hintText,
    showHint: hintText.length > 0,
    railAccentColor: input.inputFocused ? "focused" : "idle",
  };
};
