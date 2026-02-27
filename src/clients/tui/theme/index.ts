/**
 * Public exports for TUI theme module.
 *
 * Purpose:
 * - Provide a single import surface for theme types and resolvers.
 * - Re-export built-in theme definitions and registry constants.
 */

export type { TuiPalette, TuiTheme, TuiThemeColors } from "./core/types";
export { NORD_THEME } from "./themes/nord_theme";
export { SOLARIZED_DARK_THEME } from "./themes/solarized_dark_theme";
export { BUILTIN_TUI_THEME_NAMES, BUILTIN_TUI_THEMES } from "./core/registry";
export { DEFAULT_TUI_THEME_NAME, resolveTuiTheme } from "./core/resolve";
