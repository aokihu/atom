import { BoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { NORD } from "../theme/nord";

export type InputPaneViewInput = {
  isBusy: boolean;
  inputFocused: boolean;
  busyIndicator?: string;
  agentName: string;
  noticeText?: string;
};

export type InputPaneViewState = {
  placeholderText: string;
  hintText: string;
  showHint: boolean;
  railAccentColor: "focused" | "idle";
};

export type InputPaneView = {
  box: BoxRenderable;
  railBox: BoxRenderable;
  railAccent: BoxRenderable;
  railTextUser: TextRenderable;
  railTextInput: TextRenderable;
  mainBox: BoxRenderable;
  hintText: TextRenderable;
  editorHost: BoxRenderable;
  textarea: TextareaRenderable;
};

export const createInputPaneView = (ctx: CliRenderer, args: {
  keyBindings: any[];
  onSubmit: () => void;
}): InputPaneView => {
  const box = new BoxRenderable(ctx, {
    border: false,
    backgroundColor: NORD.nord1,
    paddingX: 1,
    width: "100%",
    flexDirection: "row",
  });

  const railBox = new BoxRenderable(ctx, {
    width: 12,
    height: "100%",
    flexDirection: "row",
    backgroundColor: NORD.nord1,
  });
  const railAccent = new BoxRenderable(ctx, {
    width: 1,
    height: "100%",
    border: ["left"],
    borderStyle: "double",
    borderColor: NORD.nord9,
    shouldFill: false,
    backgroundColor: NORD.nord1,
  });
  const railTextBox = new BoxRenderable(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    paddingLeft: 1,
    backgroundColor: NORD.nord1,
  });
  const railTextUser = new TextRenderable(ctx, {
    content: " ",
    fg: NORD.nord9,
    width: "100%",
    truncate: true,
    visible: false,
  });
  const railTextInput = new TextRenderable(ctx, {
    content: " ",
    fg: NORD.nord4,
    width: "100%",
    truncate: true,
    visible: false,
  });
  railTextBox.add(railTextUser);
  railTextBox.add(railTextInput);
  railBox.add(railAccent);

  const mainBox = new BoxRenderable(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingLeft: 0,
    paddingRight: 1,
    backgroundColor: NORD.nord1,
  });
  const hintText = new TextRenderable(ctx, { content: "", fg: NORD.nord3, width: "100%", truncate: true });
  const editorHost = new BoxRenderable(ctx, {
    width: "100%",
    height: 1,
    backgroundColor: NORD.nord1,
  });
  const textarea = new TextareaRenderable(ctx, {
    width: "100%",
    height: "100%",
    initialValue: "",
    backgroundColor: NORD.nord1,
    focusedBackgroundColor: NORD.nord2,
    textColor: NORD.nord5,
    focusedTextColor: NORD.nord6,
    placeholderColor: NORD.nord3,
    wrapMode: "word",
    keyBindings: args.keyBindings,
    onSubmit: args.onSubmit,
  });
  editorHost.add(textarea);
  mainBox.add(hintText);
  mainBox.add(editorHost);

  box.add(railBox);
  box.add(mainBox);

  return {
    box,
    railBox,
    railAccent,
    railTextUser,
    railTextInput,
    mainBox,
    hintText,
    editorHost,
    textarea,
  };
};

export const buildInputPaneViewState = (input: InputPaneViewInput): InputPaneViewState => {
  const placeholderText = input.isBusy
    ? `${input.busyIndicator ?? "Task in progress..."} (input locked)`
    : `Ask ${input.agentName} · Enter=submit · Shift+Enter=newline · /=commands`;

  const hintText = input.noticeText?.trim() ?? "";

  return {
    placeholderText,
    hintText,
    showHint: hintText.length > 0,
    railAccentColor: input.inputFocused ? "focused" : "idle",
  };
};
