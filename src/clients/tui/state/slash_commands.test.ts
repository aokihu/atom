import { describe, expect, test } from "bun:test";
import {
  filterEnabledSlashCommands,
  resolveSlashCommandAction,
} from "./slash_commands";

describe("slash command registry", () => {
  test("returns only enabled commands for slash modal options", () => {
    const commands = filterEnabledSlashCommands("");
    expect(commands.map((item) => item.name)).toEqual([
      "/exit",
      "/context",
      "/schedule",
      "/force_abort",
      "/clear",
    ]);
  });

  test("filters enabled commands by query", () => {
    const commands = filterEnabledSlashCommands("con");
    expect(commands.map((item) => item.name)).toEqual(["/context"]);
  });

  test("resolves actions from the single command registry", () => {
    expect(resolveSlashCommandAction("/exit")).toEqual({ type: "exit" });
    expect(resolveSlashCommandAction("/context")).toEqual({ type: "open_context" });
    expect(resolveSlashCommandAction("/schedule")).toEqual({ type: "open_schedule" });
    expect(resolveSlashCommandAction("/force_abort")).toEqual({ type: "force_abort" });
    expect(resolveSlashCommandAction("/clear")).toEqual({ type: "clear_session_view" });
    expect(resolveSlashCommandAction("/help")).toEqual({
      type: "hidden",
      message: "/help hidden in conversation layout",
    });
    expect(resolveSlashCommandAction("/messages")).toEqual({
      type: "hidden",
      message: "/messages hidden in conversation layout",
    });
    expect(resolveSlashCommandAction("/unknown")).toEqual({
      type: "unknown",
      message: "Unknown command: /unknown",
    });
  });
});
