import { describe, expect, test } from "bun:test";

import { escapeMarkdownV2 } from "./markdown_v2";

describe("escapeMarkdownV2", () => {
  test("escapes Telegram MarkdownV2 special chars", () => {
    const input = "_*[]()~`>#+-=|{}.!\\";
    const escaped = escapeMarkdownV2(input);
    expect(escaped).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
  });
});
