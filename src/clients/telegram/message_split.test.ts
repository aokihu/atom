import { describe, expect, test } from "bun:test";

import { splitTelegramMessage } from "./message_split";

describe("splitTelegramMessage", () => {
  test("splits long text by chunk size", () => {
    const chunks = splitTelegramMessage("abcdefgh", 3);
    expect(chunks).toEqual(["abc", "def", "gh"]);
  });

  test("throws when chunk size is invalid", () => {
    expect(() => splitTelegramMessage("abc", 0)).toThrow("chunkSize must be greater than 0");
  });

  test("avoids trailing standalone backslash in chunk", () => {
    const chunks = splitTelegramMessage("abc\\def", 4);
    expect(chunks).toEqual(["abc", "\\def"]);
  });
});
