import { Box, instantiate } from "@opentui/core";
import type {
  BoxRenderable,
  CliRenderer,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";

import type { TuiTheme } from "../theme";
import { createContextModalView } from "../views/context_modal";
import { createInputPaneView } from "../views/input_pane";
import { createMessagePaneView } from "../views/message_pane";
import { createSlashModalView } from "../views/slash_modal";
import { createStatusStripView } from "../views/status_strip";

// ================================
// 类型定义区
// ================================

export type TuiClientUiBundle = {
  appRoot: BoxRenderable;

  messageBox: BoxRenderable;
  messageHeaderText: TextRenderable;
  messageSubHeaderText: TextRenderable;
  messageScroll: ScrollBoxRenderable;
  messageListBox: BoxRenderable;

  statusBox: BoxRenderable;
  statusRowTexts: [TextRenderable, TextRenderable];

  inputBox: BoxRenderable;
  inputRailBox: BoxRenderable;
  inputRailAccent: BoxRenderable;
  inputRailAccentGlyph: TextRenderable;
  inputRailTextUser: TextRenderable;
  inputRailTextInput: TextRenderable;
  inputMainBox: BoxRenderable;
  inputHintText: TextRenderable;
  inputEditorHost: BoxRenderable;
  inputTextarea: TextareaRenderable;

  slashOverlay: BoxRenderable;
  slashBackdrop: BoxRenderable;
  slashModalBox: BoxRenderable;
  slashModalTitleText: TextRenderable;
  slashModalQueryText: TextRenderable;
  slashModalEmptyText: TextRenderable;
  slashModalSelect: SelectRenderable;

  contextOverlay: BoxRenderable;
  contextBackdrop: BoxRenderable;
  contextModalBox: BoxRenderable;
  contextModalTitleText: TextRenderable;
  contextModalHintText: TextRenderable;
  contextModalScroll: ScrollBoxRenderable;
  contextModalContentBox: BoxRenderable;
  contextModalBodyText: TextRenderable;

  mount: (renderer: CliRenderer) => void;
  unmount: (renderer: CliRenderer) => void;
  destroyTrees: () => void;
};

// ================================
// 导出接口区（UI Bundle 组装）
// ================================

export const createTuiClientUiBundle = (
  renderer: CliRenderer,
  args: {
    theme: TuiTheme;
    textareaKeyBindings: any[];
    onInputSubmit: () => void;
    onSlashSelect: () => void;
  },
): TuiClientUiBundle => {
  const C = args.theme.colors;

  // UI 渲染区：应用根容器（消息区 / 状态条 / 输入区）
  const appRoot = instantiate(
    renderer,
    Box({
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: C.appBackground,
    }),
  ) as unknown as BoxRenderable;

  const messagePaneView = createMessagePaneView(renderer, args.theme);
  const statusStripView = createStatusStripView(renderer, args.theme);
  const inputPaneView = createInputPaneView(renderer, args.theme, {
    keyBindings: args.textareaKeyBindings,
    onSubmit: args.onInputSubmit,
  });
  const slashModalView = createSlashModalView(renderer, args.theme, args.onSlashSelect);
  const contextModalView = createContextModalView(renderer, args.theme);

  // 生命周期区：挂载/卸载/销毁集中管理，避免外层分散处理树结构
  const mount = (targetRenderer: CliRenderer) => {
    appRoot.add(messagePaneView.box);
    appRoot.add(statusStripView.box);
    appRoot.add(inputPaneView.box);
    targetRenderer.root.add(appRoot);
    targetRenderer.root.add(slashModalView.overlay);
    targetRenderer.root.add(contextModalView.overlay);
  };

  const unmount = (targetRenderer: CliRenderer) => {
    try {
      targetRenderer.root.remove(appRoot.id);
    } catch {
      // noop
    }
    try {
      targetRenderer.root.remove(slashModalView.overlay.id);
    } catch {
      // noop
    }
    try {
      targetRenderer.root.remove(contextModalView.overlay.id);
    } catch {
      // noop
    }
  };

  const destroyTrees = () => {
    if (!appRoot.isDestroyed) appRoot.destroyRecursively();
    if (!slashModalView.overlay.isDestroyed) slashModalView.overlay.destroyRecursively();
    if (!contextModalView.overlay.isDestroyed) contextModalView.overlay.destroyRecursively();
  };

  return {
    appRoot,

    messageBox: messagePaneView.box,
    messageHeaderText: messagePaneView.headerText,
    messageSubHeaderText: messagePaneView.subHeaderText,
    messageScroll: messagePaneView.scroll,
    messageListBox: messagePaneView.listBox,

    statusBox: statusStripView.box,
    statusRowTexts: statusStripView.rowTexts,

    inputBox: inputPaneView.box,
    inputRailBox: inputPaneView.railBox,
    inputRailAccent: inputPaneView.railAccent,
    inputRailAccentGlyph: inputPaneView.railAccentGlyph,
    inputRailTextUser: inputPaneView.railTextUser,
    inputRailTextInput: inputPaneView.railTextInput,
    inputMainBox: inputPaneView.mainBox,
    inputHintText: inputPaneView.hintText,
    inputEditorHost: inputPaneView.editorHost,
    inputTextarea: inputPaneView.textarea,

    slashOverlay: slashModalView.overlay,
    slashBackdrop: slashModalView.backdrop,
    slashModalBox: slashModalView.modalBox,
    slashModalTitleText: slashModalView.titleText,
    slashModalQueryText: slashModalView.queryText,
    slashModalEmptyText: slashModalView.emptyText,
    slashModalSelect: slashModalView.select,

    contextOverlay: contextModalView.overlay,
    contextBackdrop: contextModalView.backdrop,
    contextModalBox: contextModalView.modalBox,
    contextModalTitleText: contextModalView.titleText,
    contextModalHintText: contextModalView.hintText,
    contextModalScroll: contextModalView.scroll,
    contextModalContentBox: contextModalView.contentBox,
    contextModalBodyText: contextModalView.bodyText,

    mount,
    unmount,
    destroyTrees,
  };
};

