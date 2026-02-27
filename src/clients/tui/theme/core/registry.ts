/**
 * Built-in TUI theme registry.
 *
 * Purpose:
 * - Register built-in themes by stable name.
 * - Export registry metadata for resolve and tests.
 */

import { NORD_THEME } from "../themes/nord_theme";
import { SOLARIZED_DARK_THEME } from "../themes/solarized_dark_theme";
import type { TuiTheme } from "./types";

export const BUILTIN_TUI_THEMES = {
  nord: NORD_THEME,
  "solarized-dark": SOLARIZED_DARK_THEME,
} as const satisfies Record<string, TuiTheme>;

export const BUILTIN_TUI_THEME_NAMES = Object.freeze(
  Object.keys(BUILTIN_TUI_THEMES),
) as readonly (keyof typeof BUILTIN_TUI_THEMES)[];
