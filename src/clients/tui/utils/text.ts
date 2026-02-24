const ELLIPSIS = "...";

const isWideCodePoint = (codePoint: number): boolean => {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  );
};

const charDisplayWidth = (char: string): number => {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
};

export const stringDisplayWidth = (value: string): number => {
  let width = 0;
  for (const char of Array.from(value)) {
    width += charDisplayWidth(char);
  }
  return width;
};

export const truncateToDisplayWidth = (value: string, width: number): string => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth <= 0) return "";
  if (stringDisplayWidth(value) <= safeWidth) return value;
  if (safeWidth <= ELLIPSIS.length) return ELLIPSIS.slice(0, safeWidth);

  const targetWidth = safeWidth - ELLIPSIS.length;
  let current = "";
  let currentWidth = 0;

  for (const char of Array.from(value)) {
    const charWidth = charDisplayWidth(char);
    if (currentWidth + charWidth > targetWidth) break;
    current += char;
    currentWidth += charWidth;
  }

  return `${current}${ELLIPSIS}`;
};

export const summarizeEventText = (text: string, maxWidth = 80): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(empty)";
  return truncateToDisplayWidth(singleLine, maxWidth);
};
