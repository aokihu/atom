import type { TuiTheme } from "../core/types";
import { SOLARIZED_DARK_PALETTE as palette } from "../palettes/solarized_dark";

export const SOLARIZED_DARK_THEME: TuiTheme = {
  name: "solarized-dark",
  palette,
  colors: {
    appBackground: palette.base03,
    panelBackground: palette.base03,
    panelBackgroundAlt: palette.base02,
    panelHeaderBackground: palette.base01,
    overlayScrim: palette.base03,
    selectionBackground: palette.base01,

    borderDefault: palette.base01,
    borderAccentPrimary: palette.blue,
    borderAccentSecondary: palette.cyan,
    borderUserAccent: palette.blue,
    borderSystemAccent: palette.cyan,

    textPrimary: palette.base2,
    textSecondary: palette.base1,
    textMuted: palette.base00,
    textSubtle: palette.base02,

    accentPrimary: palette.cyan,
    accentSecondary: palette.blue,
    accentTertiary: palette.green,

    statusRunning: palette.cyan,
    statusSuccess: palette.green,
    statusError: palette.red,
    statusWarning: palette.yellow,

    scrollbarThumb: palette.base00,
    scrollbarTrack: palette.base02,

    inputPlaceholder: palette.base00,
    inputText: palette.base2,
    inputTextFocused: palette.base3,
  },
};
