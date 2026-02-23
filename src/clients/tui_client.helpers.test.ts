import { describe, expect, it } from "bun:test";

import {
  clampScrollOffset,
  computeScrollbarThumb,
  summarizeEventText,
  wrapContentToLines,
} from "./tui_client";

describe("wrapContentToLines", () => {
  it("keeps short text on one line", () => {
    expect(wrapContentToLines("hello", 10)).toEqual(["hello"]);
  });

  it("hard-wraps long text without spaces", () => {
    expect(wrapContentToLines("abcdef", 3)).toEqual(["abc", "def"]);
  });

  it("preserves explicit line breaks", () => {
    expect(wrapContentToLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("wraps common CJK wide characters", () => {
    expect(wrapContentToLines("你好世界", 4)).toEqual(["你好", "世界"]);
  });
});

describe("clampScrollOffset", () => {
  it("returns zero when content fits viewport", () => {
    expect(clampScrollOffset(10, 3, 5)).toBe(0);
  });

  it("clamps negative values", () => {
    expect(clampScrollOffset(-3, 20, 5)).toBe(0);
  });

  it("clamps to max offset", () => {
    expect(clampScrollOffset(999, 20, 5)).toBe(15);
  });
});

describe("computeScrollbarThumb", () => {
  it("hides thumb when scrolling is not needed", () => {
    expect(computeScrollbarThumb(5, 5, 0)).toEqual({
      visible: false,
      start: 0,
      size: 5,
    });
  });

  it("returns a visible thumb with minimum size", () => {
    const thumb = computeScrollbarThumb(200, 3, 10);
    expect(thumb.visible).toBe(true);
    expect(thumb.size).toBeGreaterThanOrEqual(1);
    expect(thumb.start).toBeGreaterThanOrEqual(0);
  });
});

describe("summarizeEventText", () => {
  it("normalizes whitespace to a single line", () => {
    expect(summarizeEventText("line1\nline2\tline3", 50)).toBe("line1 line2 line3");
  });

  it("truncates long summaries", () => {
    expect(summarizeEventText("1234567890", 6)).toBe("123...");
  });
});
