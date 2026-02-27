import { describe, expect, test } from "bun:test";

import { parseCliOptions } from "./cli";

describe("parseCliOptions", () => {
  test("accepts telegram mode", () => {
    const options = parseCliOptions(["--mode", "telegram"], "/tmp/workspace");
    expect(options.mode).toBe("telegram");
  });

  test("accepts telegram-client mode with explicit server-url", () => {
    const options = parseCliOptions(
      ["--mode", "telegram-client", "--server-url", "http://127.0.0.1:8787"],
      "/tmp/workspace",
    );

    expect(options.mode).toBe("telegram-client");
    expect(options.serverUrl).toBe("http://127.0.0.1:8787");
  });

  test("rejects invalid mode and lists telegram modes", () => {
    expect(() =>
      parseCliOptions(["--mode", "invalid-mode"], "/tmp/workspace"),
    ).toThrow("telegram-client");
  });

  test("rejects invalid server-url", () => {
    expect(() =>
      parseCliOptions(["--mode", "telegram-client", "--server-url", "not-url"], "/tmp/workspace"),
    ).toThrow("Invalid --server-url");
  });
});
