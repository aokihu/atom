/**
 * Tests for TUI theme registry.
 *
 * Purpose:
 * - Verify built-in registry integrity and semantic color completeness.
 * - Catch accidental theme registration regressions.
 */

import { describe, expect, test } from "bun:test";

import { BUILTIN_TUI_THEME_NAMES, BUILTIN_TUI_THEMES } from "../core/registry";
import { NORD_THEME } from "../themes/nord_theme";

const REQUIRED_COLOR_KEYS = [
  "appBackground",
  "panelBackground",
  "panelBackgroundAlt",
  "panelHeaderBackground",
  "overlayScrim",
  "selectionBackground",
  "borderDefault",
  "borderAccentPrimary",
  "borderAccentSecondary",
  "borderUserAccent",
  "borderSystemAccent",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "textSubtle",
  "accentPrimary",
  "accentSecondary",
  "accentTertiary",
  "statusRunning",
  "statusSuccess",
  "statusError",
  "statusWarning",
  "scrollbarThumb",
  "scrollbarTrack",
  "inputPlaceholder",
  "inputText",
  "inputTextFocused",
] as const;

const isHexColor = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value);

describe("tui theme registry", () => {
  test("exports nord as a builtin theme", () => {
    expect(BUILTIN_TUI_THEMES.nord).toBe(NORD_THEME);
    expect(BUILTIN_TUI_THEME_NAMES).toContain("nord");
  });

  test("builtin theme names match registry keys", () => {
    const registryKeys = Object.keys(
      BUILTIN_TUI_THEMES,
    ) as Array<keyof typeof BUILTIN_TUI_THEMES>;
    expect([...BUILTIN_TUI_THEME_NAMES].sort()).toEqual([...registryKeys].sort());
  });

  test("builtin themes expose non-empty names and palettes", () => {
    for (const [key, theme] of Object.entries(BUILTIN_TUI_THEMES)) {
      expect(theme.name).toBe(key);
      expect(Object.keys(theme.palette).length).toBeGreaterThan(0);

      for (const [paletteKey, color] of Object.entries(theme.palette)) {
        expect(paletteKey.length).toBeGreaterThan(0);
        expect(color.length).toBeGreaterThan(0);
        expect(isHexColor(color)).toBe(true);
      }
    }
  });

  test("builtin themes provide every required semantic color", () => {
    for (const theme of Object.values(BUILTIN_TUI_THEMES)) {
      for (const key of REQUIRED_COLOR_KEYS) {
        const value = theme.colors[key];
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
        expect(isHexColor(value)).toBe(true);
      }
    }
  });
});
