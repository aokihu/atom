import { describe, expect, test } from "bun:test";

import type { StatusStripView, StatusStripViewInput } from "./status_strip";
import {
  buildTokenUsageLabel,
  buildMessageGatewayTagLabel,
  buildMcpTagLabel,
  createMessageGatewayTagMouseUpHandler,
  createMcpTagMouseUpHandler,
  isLeftMouseButton,
  updateStatusStripView,
} from "./status_strip";

const createInput = (): StatusStripViewInput => ({
  layout: {
    mode: "full",
    messageHeight: 20,
    showStatusStrip: true,
    statusHeight: 3,
    statusRows: 1,
    inputHeight: 8,
    inputHintHeight: 1,
    railWidth: 1,
    compactStatus: false,
  },
  terminal: { columns: 120, rows: 40 },
  rowWidth: 116,
  mode: "tui",
  agentName: "Atom",
  version: "0.12.1",
  connection: "ok",
  phase: "idle",
  statusNotice: "Ready",
  mcpConnected: 3,
  mcpTotal: 5,
  messageGatewayHealthAvailable: true,
  messageGatewayRunning: 2,
  messageGatewayConfigured: 3,
});

const createFakeView = (): StatusStripView => ({
  box: { visible: true, height: 0 } as any,
  rowPrimary: { visible: true } as any,
  leftText: { content: "" } as any,
  mcpTagText: { content: "" } as any,
  messageGatewayTagText: { content: "" } as any,
  rightText: { content: "" } as any,
  rowSecondary: { visible: false, content: "" } as any,
});

describe("status strip mcp tag", () => {
  test("renders MCP ratio label", () => {
    expect(buildMcpTagLabel(2, 7)).toBe("[MCP Tools: 2/7]");
  });

  test("renders message gateway label", () => {
    expect(buildMessageGatewayTagLabel(true, 1, 4)).toBe("[Channels: 1/4]");
    expect(buildMessageGatewayTagLabel(false, 0, 0)).toBe("[Channels: off]");
  });

  test("renders token usage label when token metrics are present", () => {
    expect(buildTokenUsageLabel({
      tokenInputTokens: 120,
      tokenOutputTokens: 30,
      tokenTotalTokens: 150,
      tokenCumulativeTokens: 2000,
    })).toBe("Tok I:120 O:30 T:150 Σ:2,000");
    expect(buildTokenUsageLabel({} as any)).toBeNull();
  });

  test("left mouse detection matches primary click only", () => {
    expect(isLeftMouseButton({ button: 0 } as any)).toBe(true);
    expect(isLeftMouseButton({ button: 1 } as any)).toBe(false);
  });

  test("left click handler triggers callback", () => {
    let clicked = 0;
    const handler = createMcpTagMouseUpHandler(() => {
      clicked += 1;
    });

    handler({ button: 1 } as any);
    handler({ button: 0 } as any);

    expect(clicked).toBe(1);
  });

  test("left click on message gateway handler triggers callback", () => {
    let clicked = 0;
    const handler = createMessageGatewayTagMouseUpHandler(() => {
      clicked += 1;
    });

    handler({ button: 1 } as any);
    handler({ button: 0 } as any);

    expect(clicked).toBe(1);
  });

  test("updates mcp text content on view sync", () => {
    const view = createFakeView();
    updateStatusStripView(view, {
      ...createInput(),
      tokenInputTokens: 120,
      tokenOutputTokens: 30,
      tokenTotalTokens: 150,
    });

    expect(String(view.mcpTagText.content)).toContain("[MCP Tools: 3/5]");
    expect(String(view.messageGatewayTagText.content)).toContain("[Channels: 2/3]");
    expect(String(view.rightText.content)).toContain("0.12.1");
    expect(String(view.leftText.content)).toContain("Atom");
    expect(String(view.leftText.content)).toContain("Tok I:120 O:30 T:150");
  });
});
