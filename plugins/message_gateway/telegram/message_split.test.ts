import { describe, expect, test } from "bun:test";

import { splitTelegramMessage } from "./message_split";

describe("splitTelegramMessage", () => {
  test("splits message into chunks by chunk size", () => {
    const chunks = splitTelegramMessage("abcdefgh", 3);
    expect(chunks).toEqual(["abc", "def", "gh"]);
  });

  test("throws for invalid chunk size", () => {
    expect(() => splitTelegramMessage("abc", 0)).toThrow("chunkSize must be greater than 0");
  });

  test("avoids splitting markdown escape boundary", () => {
    const chunks = splitTelegramMessage("abc\\def", 4);
    expect(chunks).toEqual(["abc", "\\def"]);
  });
});
