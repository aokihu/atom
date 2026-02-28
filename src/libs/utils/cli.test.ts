import { describe, expect, test } from "bun:test";

import { parseCliOptions } from "./cli";

describe("parseCliOptions", () => {
  test("accepts server mode", () => {
    const options = parseCliOptions(["--mode", "server"], "/tmp/workspace");
    expect(options.mode).toBe("server");
  });

  test("accepts tui-client mode with explicit server-url", () => {
    const options = parseCliOptions(
      ["--mode", "tui-client", "--server-url", "http://127.0.0.1:8787"],
      "/tmp/workspace",
    );

    expect(options.mode).toBe("tui-client");
    expect(options.serverUrl).toBe("http://127.0.0.1:8787");
  });

  test("rejects invalid mode and lists supported modes", () => {
    expect(() =>
      parseCliOptions(["--mode", "invalid-mode"], "/tmp/workspace"),
    ).toThrow("tui-client");
  });

  test("rejects legacy telegram mode", () => {
    expect(() =>
      parseCliOptions(["--mode", "telegram"], "/tmp/workspace"),
    ).toThrow("Supported values: tui, server, tui-client");
  });

  test("rejects invalid server-url", () => {
    expect(() =>
      parseCliOptions(["--mode", "tui-client", "--server-url", "not-url"], "/tmp/workspace"),
    ).toThrow("Invalid --server-url");
  });

  test("parses --channels filter list", () => {
    const options = parseCliOptions(
      ["--mode", "server", "--channels", "telegram_main,http_ingress"],
      "/tmp/workspace",
    );
    expect(options.channels).toEqual(["telegram_main", "http_ingress"]);
  });
});
