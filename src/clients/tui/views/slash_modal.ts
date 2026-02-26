/**
 * TUI 组件：Slash Modal（斜杠命令选择弹层）
 * 用于何处：被 `src/clients/tui/runtime/ui.ts` 装配为全屏 overlay，由 `CoreTuiClientApp` 在输入 `/` 命令时展示和更新。
 * 主要职责：构建命令选择弹层节点树，并根据终端尺寸/命令列表计算弹层位置、尺寸和可视状态。
 *
 * ASCII Layout
 * +---------------------- overlay (full screen) -----------------------+
 * | +------------------- backdrop / scrim ---------------------------+  |
 * | +---------------------------------------------------------------+  |
 * |            +--------------- modalBox ----------------+             |
 * |            | titleText                               |             |
 * |            | emptyText (when no options)             |             |
 * |            | select (command list)                   |             |
 * |            +-----------------------------------------+             |
 * +-------------------------------------------------------------------+
 */
import {
  Box,
  Select,
  SelectRenderableEvents,
  Text,
  instantiate,
} from "@opentui/core";
import type { BoxRenderable, CliRenderer, SelectRenderable, TextRenderable } from "@opentui/core";

import type { LayoutMetrics, TerminalSize } from "../layout/metrics";
import type { SlashCommandOption } from "../state/slash_commands";
import type { TuiTheme } from "../theme";
import { truncateToDisplayWidth } from "../utils/text";

// ================================
// 类型定义区
// ================================

export type SlashModalLayoutInput = {
  terminal: TerminalSize;
  layout: LayoutMetrics;
  filteredQuery: string;
  commands: SlashCommandOption[];
  selectedIndex: number;
};

export type SlashModalLayoutState = {
  width: number;
  height: number;
  top: number;
  left: number;
  listHeight: number;
  titleText: string;
  queryText: string;
  emptyVisible: boolean;
  emptyText: string;
  hasOptions: boolean;
  selectedIndex: number;
  options: Array<{
    name: string;
    description: string;
    value: string;
  }>;
};

export type SlashModalView = {
  overlay: BoxRenderable;
  backdrop: BoxRenderable;
  modalBox: BoxRenderable;
  titleText: TextRenderable;
  queryText: TextRenderable;
  emptyText: TextRenderable;
  select: SelectRenderable;
};

// ================================
// 逻辑计算区（布局与文案）
// ================================

export const buildSlashModalLayoutState = (input: SlashModalLayoutInput): SlashModalLayoutState => {
  const width = Math.max(28, Math.min(64, input.terminal.columns - 6));
  const listHeight = Math.min(6, Math.max(3, input.commands.length || 3));
  const height = 1 + 2 + listHeight;
  const inputTop = input.terminal.rows - input.layout.inputHeight;
  const anchorLeft = 2;
  const desiredTop = inputTop - height - 1;
  const top = Math.max(1, desiredTop);
  const left = Math.max(1, Math.min(anchorLeft, input.terminal.columns - width - 1));
  const hasOptions = input.commands.length > 0;

  return {
    width,
    height,
    top,
    left,
    listHeight,
    titleText: truncateToDisplayWidth("Slash Commands", width - 4),
    queryText: truncateToDisplayWidth(`Query: /${input.filteredQuery}`, width - 4),
    emptyVisible: !hasOptions,
    emptyText: hasOptions ? " " : "No visible commands (only /exit is enabled)",
    hasOptions,
    selectedIndex: Math.min(input.selectedIndex, Math.max(0, input.commands.length - 1)),
    options: input.commands.map((command) => ({
      name: `${command.name} · ${command.description}`,
      description: command.description,
      value: command.name,
    })),
  };
};

// ================================
// UI 渲染区（Constructs 节点树）
// ================================

export const createSlashModalView = (
  ctx: CliRenderer,
  theme: TuiTheme,
  onSelectCommand: () => void,
): SlashModalView => {
  const C = theme.colors;

  // UI 渲染区：全屏 overlay（点击/键盘交互由外层控制，这里只负责视觉层级）
  const overlay = instantiate(
    ctx,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 50,
      visible: false,
      backgroundColor: "transparent",
    }),
  ) as unknown as BoxRenderable;

  // UI 渲染区：背景遮罩层
  const backdrop = instantiate(
    ctx,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: C.overlayScrim,
      opacity: 0.45,
    }),
  ) as unknown as BoxRenderable;

  // UI 渲染区：弹窗主体（标题/空态/选择列表）
  const modalBox = instantiate(
    ctx,
    Box({
      width: 56,
      height: 10,
      position: "absolute",
      top: 0,
      left: 0,
      border: true,
      borderStyle: "single",
      borderColor: C.borderAccentPrimary,
      backgroundColor: C.panelBackgroundAlt,
      paddingX: 1,
      flexDirection: "column",
      zIndex: 51,
    }),
  ) as unknown as BoxRenderable;

  const titleText = instantiate(
    ctx,
    Text({
      content: "Slash Commands",
      fg: C.accentPrimary,
      width: "100%",
      truncate: true,
    }),
  ) as unknown as TextRenderable;

  // UI 渲染区：查询文案节点保留（当前未挂载，保持与旧逻辑一致）
  // 部件说明：查询文本节点（历史结构兼容保留，便于后续恢复显示）。
  const queryText = instantiate(
    ctx,
    Text({
      content: "/",
      fg: C.textSecondary,
      width: "100%",
      truncate: true,
      visible: false,
    }),
  ) as unknown as TextRenderable;

  // 部件说明：空列表提示文本（无可见命令时显示）。
  const emptyText = instantiate(
    ctx,
    Text({
      content: "No commands",
      fg: C.textMuted,
      width: "100%",
      visible: false,
      truncate: true,
    }),
  ) as unknown as TextRenderable;

  // 部件说明：命令列表选择器（选中事件交由外层处理实际命令填充）。
  const select = instantiate(
    ctx,
    Select({
      width: "100%",
      height: 4,
      options: [],
      showDescription: false,
      selectedIndex: 0,
      backgroundColor: C.panelBackgroundAlt,
      focusedBackgroundColor: C.panelBackgroundAlt,
      textColor: C.textSecondary,
      focusedTextColor: C.textSecondary,
      descriptionColor: C.textMuted,
      selectedDescriptionColor: C.textSecondary,
      selectedBackgroundColor: C.selectionBackground,
      selectedTextColor: C.textPrimary,
    }),
  ) as unknown as SelectRenderable;

  // 事件处理区：选中命令后由外层注入回调执行实际动作
  select.on(SelectRenderableEvents.ITEM_SELECTED, onSelectCommand);

  modalBox.add(titleText);
  modalBox.add(emptyText);
  modalBox.add(select);
  overlay.add(backdrop);
  overlay.add(modalBox);

  return {
    overlay,
    backdrop,
    modalBox,
    titleText,
    queryText,
    emptyText,
    select,
  };
};
