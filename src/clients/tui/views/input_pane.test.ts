import { describe, expect, test } from "bun:test";

import { buildInputPaneViewState } from "./input_pane";

describe("input pane view state", () => {
  test("maps busy input state to locked placeholder and focused rail", () => {
    const state = buildInputPaneViewState({
      isBusy: true,
      inputFocused: true,
      busyIndicator: "| generating",
      agentName: "Atom",
      noticeText: "",
    });

    expect(state.placeholderText).toContain("input locked");
    expect(state.placeholderText).toContain("| generating");
    expect(state.railAccentColor).toBe("focused");
    expect(state.showHint).toBe(false);
  });

  test("maps idle input state to default placeholder and visible notice", () => {
    const state = buildInputPaneViewState({
      isBusy: false,
      inputFocused: false,
      agentName: "Atom",
      noticeText: "  Press Ctrl+C again to exit  ",
    });

    expect(state.placeholderText).toContain("Ask Atom");
    expect(state.railAccentColor).toBe("idle");
    expect(state.showHint).toBe(true);
    expect(state.hintText).toBe("Press Ctrl+C again to exit");
  });
});
