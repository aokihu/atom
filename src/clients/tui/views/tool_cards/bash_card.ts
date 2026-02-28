import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { TuiTheme } from "../../theme";
import type { ChatMessageCardInput } from "../message_pane";
import type { ToolCardStyledLine } from "../tool_templates";
import {
  getMessagePaneCompatColors,
  getToolDisplayFieldValueFromItem,
  getToolLineTextColor,
  getToolStatusColor,
  mountBox,
  mountText,
  stringifyToolStyledLine,
} from "./shared";

const getBashToolCommandText = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string => {
  const command = getToolDisplayFieldValueFromItem(item, "command");

  if (command && command.trim().length > 0) return command;
  if (item.callSummary?.trim()) return item.callSummary.trim();
  if (item.resultSummary?.trim()) return item.resultSummary.trim();
  return "bash";
};

const getBashToolCwdText = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string => {
  const cwd = getToolDisplayFieldValueFromItem(item, "cwd");
  if (cwd && cwd.trim().length > 0) return cwd;
  return getBashToolCommandText(item);
};

const getBashToolTitleText = (item: Extract<ChatMessageCardInput, { role: "tool" }>): string => {
  const cwd = getBashToolCwdText(item).trim();
  const command = getBashToolCommandText(item).trim();
  if (cwd.length > 0 && command.length > 0) return `${cwd} | ${command}`;
  if (cwd.length > 0) return cwd;
  if (command.length > 0) return command;
  return "bash";
};

export const renderBashToolCardBody = (args: {
  renderer: CliRenderer;
  theme: TuiTheme;
  bodyWrap: BoxRenderable;
  item: Extract<ChatMessageCardInput, { role: "tool" }>;
  styledLines: ToolCardStyledLine[];
}) => {
  const { renderer, theme, bodyWrap, item, styledLines } = args;
  const NORD = getMessagePaneCompatColors(theme);
  const statusColor = getToolStatusColor(theme, item.status);
  const commandText = getBashToolCommandText(item);
  const titleText = item.collapsed ? getBashToolTitleText(item) : getBashToolCwdText(item);
  const outputLines = styledLines.filter((line) => line.kind === "previewLine");
  const runtimeHintRows = item.status === "running" && outputLines.length === 0 ? 1 : 0;
  const contentRows = 1 + (outputLines.length > 0 ? 1 + outputLines.length : runtimeHintRows);
  const lineHeight = Math.max(2, Math.min(5, contentRows));

  const frame = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord2,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });
  frame.add(
    mountText(renderer, {
      content: " ",
      fg: NORD.nord2,
      width: "100%",
      truncate: true,
    }),
  );

  const headerRow = mountBox(renderer, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    backgroundColor: NORD.nord2,
    paddingLeft: 0,
    paddingRight: 1,
  });
  const bashBadge = mountBox(renderer, {
    flexDirection: "row",
    height: 1,
    width: 6,
    backgroundColor: NORD.nord14,
    paddingLeft: 1,
    paddingRight: 1,
  });
  bashBadge.add(
    mountText(renderer, {
      content: "BASH",
      fg: NORD.nord0,
      width: "100%",
      truncate: true,
    }),
  );
  headerRow.add(bashBadge);
  headerRow.add(
    mountText(renderer, {
      content: "  ",
      fg: NORD.nord3,
    }),
  );
  headerRow.add(
    mountText(renderer, {
      content: titleText,
      fg: NORD.nord6,
      width: "100%",
      truncate: true,
    }),
  );
  frame.add(headerRow);

  if (item.collapsed) {
    frame.add(
      mountText(renderer, {
        content: " ",
        fg: NORD.nord2,
        width: "100%",
        truncate: true,
      }),
    );
    frame.add(
      mountText(renderer, {
        content: "[ + 展开 ]",
        fg: statusColor,
      }),
    );
    frame.add(
      mountText(renderer, {
        content: " ",
        fg: NORD.nord2,
        width: "100%",
        truncate: true,
      }),
    );
    bodyWrap.add(frame);
    return;
  }

  const panelBox = mountBox(renderer, {
    width: "100%",
    height: lineHeight,
    flexDirection: "column",
    backgroundColor: NORD.nord2,
    marginTop: 1,
    paddingLeft: 0,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });
  const panelContent = mountBox(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord2,
  });
  panelBox.add(panelContent);
  frame.add(panelBox);

  const contentRowsToRender: Array<{ text: string; fg: string }> = [
    { text: `$ ${commandText}`, fg: NORD.nord8 },
  ];
  if (outputLines.length > 0) {
    contentRowsToRender.push({ text: "", fg: NORD.nord3 });
    for (const line of outputLines) {
      contentRowsToRender.push({
        text: stringifyToolStyledLine(line),
        fg: getToolLineTextColor(theme, line),
      });
    }
  } else if (item.status === "running") {
    contentRowsToRender.push({ text: "Running...", fg: NORD.nord4 });
  }

  const visibleRows = contentRowsToRender.length > lineHeight
    ? [contentRowsToRender[0]!, ...contentRowsToRender.slice(-(lineHeight - 1))]
    : contentRowsToRender;

  for (const row of visibleRows) {
    panelContent.add(
      mountText(renderer, {
        content: row.text,
        fg: row.fg,
        width: "100%",
        wrapMode: "char",
      }),
    );
  }

  for (let index = visibleRows.length; index < lineHeight; index += 1) {
    panelContent.add(
      mountText(renderer, {
        content: "",
        fg: NORD.nord3,
        width: "100%",
      }),
    );
  }

  frame.add(
    mountText(renderer, {
      content: "",
      fg: NORD.nord3,
      width: "100%",
    }),
  );
  frame.add(
    mountText(renderer, {
      content: "[ - 折叠 ]",
      fg: statusColor,
    }),
  );
  frame.add(
    mountText(renderer, {
      content: " ",
      fg: NORD.nord2,
      width: "100%",
      truncate: true,
    }),
  );
  bodyWrap.add(frame);
};
