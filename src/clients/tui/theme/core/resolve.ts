import { BUILTIN_TUI_THEMES } from "./registry";
import type { TuiTheme } from "./types";

export const DEFAULT_TUI_THEME_NAME = "nord";

const warnedMissingThemes = new Set<string>();

export const resolveTuiTheme = (themeName?: string): TuiTheme => {
  const normalizedName = themeName?.trim();
  if (!normalizedName) {
    return BUILTIN_TUI_THEMES[DEFAULT_TUI_THEME_NAME];
  }

  const resolved = BUILTIN_TUI_THEMES[normalizedName as keyof typeof BUILTIN_TUI_THEMES];
  if (resolved) {
    return resolved;
  }

  if (!warnedMissingThemes.has(normalizedName)) {
    warnedMissingThemes.add(normalizedName);
    console.warn(
      `[tui] unknown theme "${normalizedName}", falling back to "${DEFAULT_TUI_THEME_NAME}"`,
    );
  }

  return BUILTIN_TUI_THEMES[DEFAULT_TUI_THEME_NAME];
};

