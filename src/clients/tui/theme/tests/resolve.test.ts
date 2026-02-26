import { afterEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_TUI_THEME_NAME, resolveTuiTheme } from "../core/resolve";

const warnSpy = mock(() => {});

afterEach(() => {
  warnSpy.mockReset();
});

describe("resolveTuiTheme", () => {
  test("returns default theme when no name is provided", () => {
    const theme = resolveTuiTheme(undefined);
    expect(theme.name).toBe(DEFAULT_TUI_THEME_NAME);
  });

  test("returns builtin theme by name", () => {
    const theme = resolveTuiTheme("nord");
    expect(theme.name).toBe("nord");
  });

  test("trims theme name before lookup", () => {
    const theme = resolveTuiTheme("  nord  ");
    expect(theme.name).toBe("nord");
  });

  test("falls back to default theme when unknown", () => {
    const originalWarn = console.warn;
    console.warn = warnSpy as any;
    try {
      const theme = resolveTuiTheme("missing-theme");
      expect(theme.name).toBe(DEFAULT_TUI_THEME_NAME);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("warns only once for the same unknown theme name", () => {
    const originalWarn = console.warn;
    console.warn = warnSpy as any;
    try {
      resolveTuiTheme("missing-theme-once");
      resolveTuiTheme("missing-theme-once");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});
