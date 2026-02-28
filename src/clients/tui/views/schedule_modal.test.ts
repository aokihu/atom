import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import { NORD_THEME } from "../theme";
import type { TerminalSize } from "../layout/metrics";
import {
  createScheduleModalViewController,
  type ScheduleModalView,
} from "./schedule_modal";

const TEST_TERMINAL: TerminalSize = {
  columns: 120,
  rows: 40,
};

const createFakeScheduleModalView = (hooks?: {
  onScrollTop?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}): ScheduleModalView => ({
  overlay: { visible: false } as any,
  backdrop: {} as any,
  modalBox: { width: 0, height: 0, top: 0, left: 0 } as any,
  titleText: { content: "" } as any,
  hintText: { content: "" } as any,
  scroll: {
    height: 0,
    scrollTo: () => hooks?.onScrollTop?.(),
    focus: () => hooks?.onFocus?.(),
    blur: () => hooks?.onBlur?.(),
  } as any,
  contentBox: {} as any,
  bodyText: { content: "" } as any,
});

describe("schedule modal controller", () => {
  test("supports open/close and renders text", () => {
    const view = createFakeScheduleModalView();
    const controller = createScheduleModalViewController({
      theme: NORD_THEME,
      view,
    });

    controller.open({
      terminal: TEST_TERMINAL,
      title: "Schedules",
      body: "schedule-1",
    });
    expect(controller.isOpen()).toBe(true);
    expect(view.overlay.visible).toBe(true);
    expect(String(view.titleText.content)).toContain("Schedules");
    expect(String(view.bodyText.content)).toContain("schedule-1");

    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(view.overlay.visible).toBe(false);
    controller.dispose();
  });

  test("supports escape handling and focus helpers", () => {
    let scrolled = 0;
    let focused = 0;
    let blurred = 0;
    const controller = createScheduleModalViewController({
      theme: NORD_THEME,
      view: createFakeScheduleModalView({
        onScrollTop: () => {
          scrolled += 1;
        },
        onFocus: () => {
          focused += 1;
        },
        onBlur: () => {
          blurred += 1;
        },
      }),
    });

    controller.syncFromAppState({
      open: true,
      terminal: TEST_TERMINAL,
      title: "Schedules",
      body: "body",
    });

    expect(controller.handleKey({ name: "escape" } as KeyEvent)).toBe(true);
    expect(controller.handleKey({ name: "return" } as KeyEvent)).toBe(false);

    controller.scrollTop();
    controller.focus();
    controller.blur();

    expect(scrolled).toBe(1);
    expect(focused).toBe(1);
    expect(blurred).toBe(1);
    controller.dispose();
  });
});
