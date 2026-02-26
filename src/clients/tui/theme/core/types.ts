export type TuiPalette = Record<string, string>;

export type TuiThemeColors = {
  appBackground: string;
  panelBackground: string;
  panelBackgroundAlt: string;
  panelHeaderBackground: string;
  overlayScrim: string;
  selectionBackground: string;

  borderDefault: string;
  borderAccentPrimary: string;
  borderAccentSecondary: string;
  borderUserAccent: string;
  borderSystemAccent: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textSubtle: string;

  accentPrimary: string;
  accentSecondary: string;
  accentTertiary: string;

  statusRunning: string;
  statusSuccess: string;
  statusError: string;
  statusWarning: string;

  scrollbarThumb: string;
  scrollbarTrack: string;

  inputPlaceholder: string;
  inputText: string;
  inputTextFocused: string;
};

export type TuiTheme = {
  name: string;
  palette: TuiPalette;
  colors: TuiThemeColors;
};

