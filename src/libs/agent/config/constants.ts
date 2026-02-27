import { BUILTIN_TOOL_NAMES } from "../tools/types";

export const AGENT_CONFIG_FILENAME = "agent.config.json";

export const BUILTIN_TOOL_PERMISSION_SECTIONS = [
  "read",
  "ls",
  "tree",
  "ripgrep",
  "write",
  "todo",
  "memory",
  "cp",
  "mv",
  "git",
  "bash",
  "background",
  "webfetch",
] as const;

// Backward-compatible export name for existing imports.
export const BUILTIN_TOOL_CONFIG_SECTIONS = [...BUILTIN_TOOL_PERMISSION_SECTIONS];

export { BUILTIN_TOOL_NAMES };
