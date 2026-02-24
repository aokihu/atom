import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";
import type { LayoutMetrics, TerminalSize } from "../layout/metrics";
import type { SlashCommandOption } from "../state/slash_commands";
import { truncateToDisplayWidth } from "../utils/text";

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

export const createSlashModalView = (
  ctx: CliRenderer,
  onSelectCommand: () => void,
): SlashModalView => {
  const overlay = new BoxRenderable(ctx, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 50,
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
    opacity: 0.45,
  });
  const modalBox = new BoxRenderable(ctx, {
    width: 56,
    height: 10,
    position: "absolute",
    top: 0,
    left: 0,
    border: true,
    borderStyle: "single",
    borderColor: NORD.nord9,
    backgroundColor: NORD.nord1,
    paddingX: 1,
    flexDirection: "column",
    zIndex: 51,
  });
  const titleText = new TextRenderable(ctx, {
    content: "Slash Commands",
    fg: NORD.nord8,
    width: "100%",
    truncate: true,
  });
  const queryText = new TextRenderable(ctx, {
    content: "/",
    fg: NORD.nord4,
    width: "100%",
    truncate: true,
  });
  const emptyText = new TextRenderable(ctx, {
    content: "No commands",
    fg: NORD.nord3,
    width: "100%",
    visible: false,
    truncate: true,
  });
  const select = new SelectRenderable(ctx, {
    width: "100%",
    height: 4,
    options: [],
    showDescription: false,
    selectedIndex: 0,
    backgroundColor: NORD.nord1,
    focusedBackgroundColor: NORD.nord1,
    textColor: NORD.nord4,
    focusedTextColor: NORD.nord4,
    descriptionColor: NORD.nord3,
    selectedDescriptionColor: NORD.nord4,
    selectedBackgroundColor: NORD.nord2,
    selectedTextColor: NORD.nord6,
  });
  select.on(SelectRenderableEvents.ITEM_SELECTED, onSelectCommand);

  modalBox.add(titleText);
  modalBox.add(queryText);
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

export const buildSlashModalLayoutState = (input: SlashModalLayoutInput): SlashModalLayoutState => {
  const width = Math.max(28, Math.min(64, input.terminal.columns - 6));
  const listHeight = Math.min(6, Math.max(3, input.commands.length || 3));
  const height = 2 + 2 + listHeight;
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
