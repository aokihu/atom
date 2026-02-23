import { describe, expect, test } from "bun:test";
import {
  canReadFile,
  canVisitUrl,
  canWriteFile,
} from "./permissions";

describe("agent tool permissions", () => {
  test("builtin deny rules override allow rules", () => {
    expect(
      canReadFile("../etc/passwd", {
        read: { allow: [".*"] },
      }),
    ).toBe(false);
  });

  test("user deny rules override user allow rules", () => {
    expect(
      canWriteFile("/tmp/foo.txt", {
        write: {
          allow: [".*"],
          deny: ["^/tmp/"],
        },
      }),
    ).toBe(false);
  });

  test("no rules defaults to allow for safe targets", () => {
    expect(canReadFile("/Users/example/work/file.txt")).toBe(true);
  });

  test("webfetch blocks local file protocol by builtin rules", () => {
    expect(
      canVisitUrl("file:///etc/passwd", {
        webfetch: { allow: [".*"] },
      }),
    ).toBe(false);
  });
});
