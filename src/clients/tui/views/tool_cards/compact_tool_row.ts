import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { TuiTheme } from "../../theme";
import type {
  ChatMessageCardInput,
  ChatMessageCardViewState,
  MessagePaneRenderItem,
  ToolGroupSummaryCardInput,
} from "../message_pane";
import { buildToolCardCollapsedSummary } from "../tool_templates";
import {
  getMessagePaneCompatColors,
  getToolCollapsedSummaryColor,
  getToolStatusColor,
  mountBox,
  mountText,
} from "./shared";

const buildToolGroupCollapsedSummaryText = (
  item: ToolGroupSummaryCardInput,
): string => `executed=${item.executed} success=${item.success} failed=${item.failed}`;

export const renderCompactToolRow = (args: {
  renderer: CliRenderer;
  theme: TuiTheme;
  bodyWrap: BoxRenderable;
  cardBackgroundColor: string;
  cardState: ChatMessageCardViewState;
  item: MessagePaneRenderItem;
}) => {
  const { renderer, theme, bodyWrap, cardBackgroundColor, cardState, item } = args;
  const NORD = getMessagePaneCompatColors(theme);
  const isTool = cardState.role === "tool";
  const isToolGroupSummary = cardState.role === "tool_group_summary";
  const isToolGroupToggle = cardState.role === "tool_group_toggle";

  const toolStatus = cardState.toolStatus ?? "done";
  const statusMark =
    isToolGroupToggle
      ? ""
      : toolStatus === "error"
        ? "✕ "
        : toolStatus === "running"
          ? "… "
          : "✓ ";
  const collapsedSummary = isTool
    ? buildToolCardCollapsedSummary(item as Extract<ChatMessageCardInput, { role: "tool" }>)
    : isToolGroupSummary
      ? buildToolGroupCollapsedSummaryText(item as ToolGroupSummaryCardInput)
      : undefined;

  const titleRow = mountBox(renderer, {
    width: "100%",
    flexDirection: "row",
    backgroundColor: cardBackgroundColor,
    paddingLeft: 1,
  });
  const titleStatusText = mountText(renderer, {
    content: isToolGroupToggle ? "" : `${statusMark} `,
    fg: getToolStatusColor(theme, toolStatus),
  });
  const titlePrefixText = mountText(renderer, {
    content: `[${cardState.titleText ?? "tool"}]`,
    fg:
      isToolGroupSummary || isToolGroupToggle
        ? getToolStatusColor(theme, toolStatus)
        : NORD.nord4,
  });
  titleRow.add(titleStatusText);
  titleRow.add(titlePrefixText);

  if (collapsedSummary) {
    const titleSummaryText = mountText(renderer, {
      content: ` ${collapsedSummary}`,
      fg: isToolGroupSummary
        ? getToolStatusColor(theme, toolStatus)
        : getToolCollapsedSummaryColor(theme, toolStatus),
      width: "100%",
      truncate: true,
    });
    titleRow.add(titleSummaryText);
  } else {
    const titleSpacer = mountText(renderer, {
      content: " ",
      fg: NORD.nord3,
      width: "100%",
    });
    titleRow.add(titleSpacer);
  }

  bodyWrap.add(titleRow);
};
