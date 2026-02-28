/**
 * Tests for Slash Modal view controller.
 *
 * Purpose:
 * - Verify modal open/close, selection navigation, and key-action mapping.
 * - Ensure command selection behavior stays stable after refactors.
 */

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import { NORD_THEME } from "../theme";
import type { LayoutMetrics } from "../layout/metrics";
import {
  createSlashModalViewController,
  type SlashModalView,
} from "./slash_modal";

const TEST_LAYOUT: LayoutMetrics = {
  mode: "full",
  messageHeight: 18,
  showStatusStrip: true,
  statusHeight: 3,
  statusRows: 1,
  inputHeight: 8,
  inputHintHeight: 1,
  railWidth: 1,
  compactStatus: false,
};

const TEST_TERMINAL = {
  columns: 120,
  rows: 40,
};

const createFakeSlashModalView = (): SlashModalView => ({
  overlay: { visible: false } as any,
  backdrop: {} as any,
  modalBox: { width: 0, height: 0, top: 0, left: 0, borderColor: "" } as any,
  titleText: { content: "" } as any,
  queryText: { content: "" } as any,
  emptyText: { visible: false, content: "" } as any,
  select: { visible: false, height: 0, options: [], selectedIndex: 0 } as any,
});

describe("slash modal controller", () => {
  test("supports open/move/apply/close flow", () => {
    const controller = createSlashModalViewController({
      theme: NORD_THEME,
      onSelectCommand: () => {},
      view: createFakeSlashModalView(),
    });

    controller.open({
      terminal: TEST_TERMINAL,
      layout: TEST_LAYOUT,
      query: "",
      commands: [
        { name: "/exit", description: "Exit", enabled: true },
        { name: "/context", description: "Context", enabled: true },
      ],
    });

    expect(controller.isOpen()).toBe(true);
    expect(controller.getSelectedIndex()).toBe(0);

    controller.moveSelection(1);
    expect(controller.getSelectedIndex()).toBe(1);
    expect(controller.applySelection()?.name).toBe("/context");

    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(controller.getFilteredCommands()).toEqual([]);

    controller.dispose();
  });

  test("maps key handling to navigation/apply/close actions", () => {
    const controller = createSlashModalViewController({
      theme: NORD_THEME,
      onSelectCommand: () => {},
      view: createFakeSlashModalView(),
    });

    controller.syncFromAppState({
      modalOpen: true,
      terminal: TEST_TERMINAL,
      layout: TEST_LAYOUT,
      filteredQuery: "",
      commands: [
        { name: "/exit", description: "Exit", enabled: true },
        { name: "/context", description: "Context", enabled: true },
      ],
      selectedIndex: 0,
    });

    const navigate = controller.handleKey({
      key: { name: "down" } as KeyEvent,
      inputFocused: true,
      singleLineSlashOnly: false,
    });
    expect(navigate).toEqual({ handled: true, kind: "navigated" });
    expect(controller.getSelectedIndex()).toBe(1);

    const autocomplete = controller.handleKey({
      key: { name: "tab" } as KeyEvent,
      inputFocused: true,
      singleLineSlashOnly: false,
    });
    expect(autocomplete).toEqual({ handled: true, kind: "autocomplete" });

    const apply = controller.handleKey({
      key: { name: "return" } as KeyEvent,
      inputFocused: true,
      singleLineSlashOnly: false,
    });
    expect(apply).toEqual({ handled: true, kind: "apply" });

    const close = controller.handleKey({
      key: { name: "escape" } as KeyEvent,
      inputFocused: true,
      singleLineSlashOnly: false,
    });
    expect(close).toEqual({ handled: true, kind: "close" });

    controller.dispose();
  });
});
