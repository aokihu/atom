import { describe, expect, test } from "bun:test";
import { validateBashCommandSafety } from "./bash_command_guard";

describe("bash command guard", () => {
  test("blocks rm -rf /", () => {
    const result = validateBashCommandSafety("rm -rf /");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.ruleId).toBe("root-rm-rf");
    }
  });

  test("blocks sudo rm -rf /", () => {
    const result = validateBashCommandSafety("sudo rm -rf /");
    expect(result.ok).toBe(false);
  });

  test("blocks dangerous subcommand in compound command", () => {
    const result = validateBashCommandSafety("echo ok && rm -rf /");
    expect(result.ok).toBe(false);
  });

  test("blocks power commands", () => {
    expect(validateBashCommandSafety("shutdown now").ok).toBe(false);
    expect(validateBashCommandSafety("reboot").ok).toBe(false);
  });

  test("blocks mkfs on block device", () => {
    const result = validateBashCommandSafety("mkfs.ext4 /dev/sda");
    expect(result.ok).toBe(false);
  });

  test("allows safe commands", () => {
    expect(validateBashCommandSafety("rm -rf ./dist").ok).toBe(true);
    expect(validateBashCommandSafety("echo hello").ok).toBe(true);
    expect(validateBashCommandSafety("git status").ok).toBe(true);
  });
});

