import type { TuiTheme } from "../core/types";
import { NORD_PALETTE as palette } from "../palettes/nord";

export const NORD_THEME: TuiTheme = {
  name: "nord",
  palette,
  colors: {
    appBackground: palette.nord0,
    panelBackground: palette.nord0,
    panelBackgroundAlt: palette.nord1,
    panelHeaderBackground: palette.nord2,
    overlayScrim: palette.nord0,
    selectionBackground: palette.nord2,

    borderDefault: palette.nord3,
    borderAccentPrimary: palette.nord9,
    borderAccentSecondary: palette.nord8,
    borderUserAccent: palette.nord9,
    borderSystemAccent: palette.nord8,

    textPrimary: palette.nord6,
    textSecondary: palette.nord4,
    textMuted: palette.nord3,
    textSubtle: palette.nord1,

    accentPrimary: palette.nord8,
    accentSecondary: palette.nord9,
    accentTertiary: palette.nord7,

    statusRunning: palette.nord8,
    statusSuccess: palette.nord14,
    statusError: palette.nord11,
    statusWarning: palette.nord8,

    scrollbarThumb: palette.nord3,
    scrollbarTrack: palette.nord1,

    inputPlaceholder: palette.nord3,
    inputText: palette.nord5,
    inputTextFocused: palette.nord6,
  },
};
