import { describe, expect, test } from "bun:test";

import { escapeMarkdownV2 } from "./markdown_v2";

describe("escapeMarkdownV2", () => {
  test("escapes Telegram MarkdownV2 special characters", () => {
    const specials = ["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!", "\\"];
    const input = specials.join(" ");
    const escaped = escapeMarkdownV2(input);

    for (const symbol of specials) {
      expect(escaped).toContain(`\\${symbol}`);
    }
  });
});
