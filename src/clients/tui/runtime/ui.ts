/**
 * TUI UI bundle assembly.
 *
 * Purpose:
 * - Construct top-level UI tree and component controllers.
 * - Expose mount/unmount/dispose lifecycle for the app coordinator.
 */

import { Box, instantiate } from "@opentui/core";
import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { TuiTheme } from "../theme";
import {
  createContextModalViewController,
  type ContextModalViewController,
} from "../views/context_modal";
import {
  createInputPaneViewController,
  type InputPaneViewController,
} from "../views/input_pane";
import {
  createMessagePaneViewController,
  type MessagePaneViewController,
} from "../views/message_pane";
import {
  createScheduleModalViewController,
  type ScheduleModalViewController,
} from "../views/schedule_modal";
import {
  createSlashModalViewController,
  type SlashModalViewController,
} from "../views/slash_modal";
import {
  createStatusStripViewController,
  type StatusStripViewController,
} from "../views/status_strip";

// ================================
// 类型定义区
// ================================

export type TuiClientUiBundle = {
  appRoot: BoxRenderable;

  message: MessagePaneViewController;
  status: StatusStripViewController;
  input: InputPaneViewController;
  slash: SlashModalViewController;
  schedule: ScheduleModalViewController;
  context: ContextModalViewController;

  mount: (renderer: CliRenderer) => void;
  unmount: (renderer: CliRenderer) => void;
  disposeControllers: () => void;
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
    onMcpTagClick: () => void;
    onMessageGatewayTagClick: () => void;
    onContextSave: () => void;
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

  const message = createMessagePaneViewController({
    renderer,
    theme: args.theme,
  });
  const status = createStatusStripViewController({
    ctx: renderer,
    theme: args.theme,
    onMcpTagClick: args.onMcpTagClick,
    onMessageGatewayTagClick: args.onMessageGatewayTagClick,
  });
  const input = createInputPaneViewController({
    ctx: renderer,
    theme: args.theme,
    keyBindings: args.textareaKeyBindings,
    onSubmit: args.onInputSubmit,
  });
  const slash = createSlashModalViewController({
    ctx: renderer,
    theme: args.theme,
    onSelectCommand: args.onSlashSelect,
  });
  const schedule = createScheduleModalViewController({
    ctx: renderer,
    theme: args.theme,
  });
  const context = createContextModalViewController({
    ctx: renderer,
    theme: args.theme,
    onSaveClick: args.onContextSave,
  });

  // 生命周期区：挂载/卸载/销毁集中管理，避免外层分散处理树结构
  const mount = (targetRenderer: CliRenderer) => {
    appRoot.add(message.view.box);
    appRoot.add(status.view.box);
    appRoot.add(input.view.box);
    targetRenderer.root.add(appRoot);
    targetRenderer.root.add(slash.view.overlay);
    targetRenderer.root.add(schedule.view.overlay);
    targetRenderer.root.add(context.view.overlay);
  };

  const unmount = (targetRenderer: CliRenderer) => {
    try {
      targetRenderer.root.remove(appRoot.id);
    } catch {
      // noop
    }
    try {
      targetRenderer.root.remove(slash.view.overlay.id);
    } catch {
      // noop
    }
    try {
      targetRenderer.root.remove(schedule.view.overlay.id);
    } catch {
      // noop
    }
    try {
      targetRenderer.root.remove(context.view.overlay.id);
    } catch {
      // noop
    }
  };

  const disposeControllers = () => {
    message.dispose();
    status.dispose();
    input.dispose();
    slash.dispose();
    schedule.dispose();
    context.dispose();
  };

  const destroyTrees = () => {
    if (!appRoot.isDestroyed) appRoot.destroyRecursively();
    if (!slash.view.overlay.isDestroyed) slash.view.overlay.destroyRecursively();
    if (!schedule.view.overlay.isDestroyed) schedule.view.overlay.destroyRecursively();
    if (!context.view.overlay.isDestroyed) context.view.overlay.destroyRecursively();
  };

  return {
    appRoot,

    message,
    status,
    input,
    slash,
    schedule,
    context,

    mount,
    unmount,
    disposeControllers,
    destroyTrees,
  };
};
