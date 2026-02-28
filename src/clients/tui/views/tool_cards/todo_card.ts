import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { TuiTheme } from "../../theme";
import type { ChatMessageCardInput, TodoToolCardModel } from "../message_pane";
import { getMessagePaneCompatColors, getToolStatusColor, mountBox, mountText } from "./shared";

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const buildTodoProgressBar = (args: {
  total?: number;
  step?: number;
  summary?: string;
  width?: number;
}): string | undefined => {
  const total = typeof args.total === "number" && args.total > 0 ? Math.floor(args.total) : undefined;
  if (!total) return undefined;

  const rawStep = typeof args.step === "number" ? Math.floor(args.step) : 0;
  const clampedStep = clampNumber(rawStep, 0, total);
  const estimatedCompleted = args.summary?.startsWith("已完成")
    ? total
    : clampNumber(clampedStep > 0 ? clampedStep - 1 : 0, 0, total);
  const width = clampNumber(Math.floor(args.width ?? 18), 8, 32);
  const fill = Math.round((estimatedCompleted / total) * width);
  const filled = "█".repeat(fill);
  const empty = "░".repeat(Math.max(0, width - fill));
  return `${filled}${empty}`;
};

export const renderTodoToolCardBody = (args: {
  renderer: CliRenderer;
  theme: TuiTheme;
  bodyWrap: BoxRenderable;
  item: Extract<ChatMessageCardInput, { role: "tool" }>;
  model: TodoToolCardModel;
  cardTitleOverride?: string;
  processMessages?: Array<Extract<ChatMessageCardInput, { role: "tool" }>>;
}) => {
  const { renderer, theme, bodyWrap, item, model, cardTitleOverride, processMessages: _processMessages } = args;
  const NORD = getMessagePaneCompatColors(theme);
  const isCollapsed = item.collapsed;
  const statusColor = getToolStatusColor(theme, item.status);
  const headerFg = item.status === "done" ? NORD.nord5 : item.status === "error" ? NORD.nord6 : NORD.nord5;
  const progress = model.progress;
  const progressTotal =
    typeof progress?.total === "number" ? Math.max(0, Math.floor(progress.total)) : undefined;
  const progressStep =
    typeof progress?.step === "number" ? Math.max(0, Math.floor(progress.step)) : undefined;
  const progressBar = buildTodoProgressBar({
    total: progressTotal,
    step: progressStep,
    summary: progress?.summary ?? model.summary,
    width: 18,
  });
  const itemsCount = model.items.length;
  const visibleItems = isCollapsed ? [] : model.items;
  const hiddenItemCount = isCollapsed ? itemsCount : 0;
  const titleText = cardTitleOverride ?? `TODO ${model.actionLabel}`;
  const progressText =
    typeof progressStep === "number" || typeof progressTotal === "number"
      ? `${typeof progressStep === "number" ? progressStep : "-"}/${typeof progressTotal === "number" ? progressTotal : "-"}`
      : "-/-";
  const statusText =
    item.status === "running" ? "RUN" : item.status === "error" ? "ERR" : "DONE";
  const hasNoItems = itemsCount === 0;
  const TODO_TITLE_CELL_WIDTH = 16;
  const TODO_STEP_BADGE_WIDTH = 15;
  const TODO_ITEMS_BADGE_WIDTH = 13;
  const TODO_STATUS_BADGE_WIDTH = 8;
  const makeTodoHeaderCell = (content: string, fg: string, width: number) =>
    mountText(renderer, {
      content,
      fg,
      width,
      truncate: true,
    });

  const frame = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord1,
  });

  if (isCollapsed) {
    const collapsedMetaParts = [
      `step ${progressText}`,
      `${itemsCount} item${itemsCount === 1 ? "" : "s"}`,
      statusText,
    ];
    const collapsedHeader = mountBox(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: NORD.nord2,
      paddingLeft: 1,
      paddingRight: 1,
    });
    collapsedHeader.add(mountText(renderer, { content: "▸", fg: NORD.nord8 }));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(mountText(renderer, { content: "●", fg: statusColor }));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(titleText, headerFg, TODO_TITLE_CELL_WIDTH));
    collapsedHeader.add(mountText(renderer, { content: " ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(`[${collapsedMetaParts[0] ?? ""}]`, NORD.nord8, TODO_STEP_BADGE_WIDTH));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(`[${collapsedMetaParts[1] ?? ""}]`, NORD.nord4, TODO_ITEMS_BADGE_WIDTH));
    collapsedHeader.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
    collapsedHeader.add(makeTodoHeaderCell(`[${collapsedMetaParts[2] ?? ""}]`, statusColor, TODO_STATUS_BADGE_WIDTH));
    collapsedHeader.add(
      mountText(renderer, {
        content: `  —  ${model.summary}`,
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );
    frame.add(collapsedHeader);

    if (progressBar) {
      const barRow = mountBox(renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: NORD.nord1,
        paddingLeft: 1,
        paddingRight: 1,
      });
      barRow.add(
        mountText(renderer, {
          content: progressBar,
          fg: NORD.nord8,
          width: "100%",
          truncate: true,
        }),
      );
      frame.add(barRow);
    }

    const hintRow = mountBox(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: NORD.nord1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    hintRow.add(
      mountText(renderer, {
        content:
          itemsCount > 0
            ? `点击展开查看 ${itemsCount} 个 TODO 项`
            : "点击展开查看详情",
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );
    frame.add(hintRow);

    bodyWrap.add(frame);
    return;
  }

  const expandedMetaParts = [
    { text: `step ${progressText}`, fg: NORD.nord8 },
    { text: `${itemsCount} item${itemsCount === 1 ? "" : "s"}`, fg: NORD.nord4 },
    { text: statusText, fg: statusColor },
  ] as const;
  const headerRow = mountBox(renderer, {
    width: "100%",
    flexDirection: "row",
    backgroundColor: NORD.nord2,
    paddingLeft: 1,
    paddingRight: 1,
  });
  headerRow.add(mountText(renderer, { content: "▾", fg: NORD.nord8 }));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(mountText(renderer, { content: "●", fg: statusColor }));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(titleText, headerFg, TODO_TITLE_CELL_WIDTH));
  headerRow.add(mountText(renderer, { content: " ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(`[${expandedMetaParts[0].text}]`, expandedMetaParts[0].fg, TODO_STEP_BADGE_WIDTH));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(`[${expandedMetaParts[1].text}]`, expandedMetaParts[1].fg, TODO_ITEMS_BADGE_WIDTH));
  headerRow.add(mountText(renderer, { content: "  ", fg: NORD.nord3 }));
  headerRow.add(makeTodoHeaderCell(`[${expandedMetaParts[2].text}]`, expandedMetaParts[2].fg, TODO_STATUS_BADGE_WIDTH));
  headerRow.add(
    mountText(renderer, {
      content: `  —  ${model.summary}`,
      fg: item.status === "error" ? NORD.nord11 : NORD.nord4,
      width: "100%",
      truncate: true,
    }),
  );
  frame.add(headerRow);

  if (hasNoItems) {
    const compactWrap = mountBox(renderer, {
      width: "100%",
      flexDirection: "column",
      backgroundColor: NORD.nord1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    });

    const metaRow = mountBox(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: NORD.nord1,
    });
    metaRow.add(mountText(renderer, { content: "TODO Items", fg: NORD.nord9 }));
    metaRow.add(
      mountText(renderer, {
        content: "  0",
        fg: NORD.nord4,
        width: "100%",
        truncate: true,
      }),
    );
    compactWrap.add(metaRow);

    compactWrap.add(
      mountText(renderer, {
        content: "No TODO items yet",
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );

    frame.add(compactWrap);
    bodyWrap.add(frame);
    return;
  }

  const contentColumn = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord1,
  });

  const itemsSection = mountBox(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: NORD.nord1,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
  });
  const itemsHeader = mountBox(renderer, {
    width: "100%",
    flexDirection: "row",
    backgroundColor: NORD.nord1,
  });
  itemsHeader.add(mountText(renderer, { content: "Items", fg: NORD.nord9 }));
  itemsHeader.add(
    mountText(renderer, {
      content: itemsCount > 0 ? `  ${itemsCount}` : "  0",
      fg: NORD.nord4,
      width: "100%",
      truncate: true,
    }),
  );
  itemsSection.add(itemsHeader);

  if (visibleItems.length === 0) {
    itemsSection.add(
      mountText(renderer, {
        content: hiddenItemCount > 0 ? `… 还有 ${hiddenItemCount} 项` : "暂无可显示的 TODO 项",
        fg: NORD.nord3,
        width: "100%",
        truncate: true,
      }),
    );
  } else {
    for (const todoItem of visibleItems) {
      const itemRow = mountBox(renderer, {
        width: "100%",
        flexDirection: "row",
        backgroundColor: NORD.nord1,
      });
      itemRow.add(
        mountText(renderer, {
          content: `${todoItem.mark} `,
          fg: todoItem.status === "done" ? NORD.nord14 : NORD.nord8,
        }),
      );
      if (typeof todoItem.id === "number") {
        itemRow.add(
          mountText(renderer, {
            content: `#${todoItem.id} `,
            fg: NORD.nord3,
          }),
        );
      }
      itemRow.add(
        mountText(renderer, {
          content: todoItem.title,
          fg: todoItem.status === "done" ? NORD.nord4 : NORD.nord6,
          width: "100%",
          wrapMode: "char",
        }),
      );
      itemsSection.add(itemRow);
    }
  }
  contentColumn.add(itemsSection);

  frame.add(contentColumn);
  bodyWrap.add(frame);
};
