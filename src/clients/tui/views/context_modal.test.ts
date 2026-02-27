/**
 * Tests for Context Modal view controller.
 *
 * Purpose:
 * - Verify open/close/focus/scroll helper behavior.
 * - Protect modal keyboard handling and state sync integration.
 */

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import { NORD_THEME } from "../theme";
import type { TerminalSize } from "../layout/metrics";
import {
  createContextModalViewController,
  type ContextModalView,
} from "./context_modal";

const TEST_TERMINAL: TerminalSize = {
  columns: 120,
  rows: 40,
};

const createFakeContextModalView = (hooks?: {
  onScrollTop?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}): ContextModalView => ({
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

describe("context modal controller", () => {
  test("supports open/close and renders layout fields", () => {
    const view = createFakeContextModalView();
    const controller = createContextModalViewController({
      theme: NORD_THEME,
      view,
    });

    controller.open({
      terminal: TEST_TERMINAL,
      title: "Agent Context",
      body: "Line 1\nLine 2",
    });

    expect(controller.isOpen()).toBe(true);
    expect(view.overlay.visible).toBe(true);
    expect(String(view.titleText.content)).toContain("Agent Context");
    expect(String(view.bodyText.content)).toContain("Line 1");

    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(view.overlay.visible).toBe(false);

    controller.dispose();
  });

  test("supports escape handling and scroll/focus helpers", () => {
    let scrolled = 0;
    let focused = 0;
    let blurred = 0;
    const controller = createContextModalViewController({
      theme: NORD_THEME,
      view: createFakeContextModalView({
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
      title: "Context",
      body: "Body",
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
