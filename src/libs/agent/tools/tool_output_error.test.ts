import { describe, expect, test } from "bun:test";
import { getToolErrorMessageFromOutput } from "./tool_output_error";

describe("tool_output_error", () => {
  test("extracts explicit error field", () => {
    expect(getToolErrorMessageFromOutput({ error: "permission denied" })).toBe("permission denied");
  });

  test("maps MCP isError payload to failure", () => {
    expect(
      getToolErrorMessageFromOutput({
        isError: true,
        content: [{ type: "text", text: "navigation failed" }],
      }),
    ).toBe("navigation failed");
  });

  test("maps success=false payload to failure", () => {
    expect(
      getToolErrorMessageFromOutput({
        success: false,
        message: "tool failed",
      }),
    ).toBe("tool failed");
  });
});
