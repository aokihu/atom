/**
 * Slash command registry for TUI.
 *
 * Purpose:
 * - Define built-in slash commands as the single source of truth.
 * - Provide both query filtering (for slash modal) and command action resolving.
 */

export type SlashCommandAction =
  | { type: "exit" }
  | { type: "open_context" }
  | { type: "force_abort" }
  | { type: "hidden"; message: string }
  | { type: "unknown"; message: string };

export type SlashCommandOption = {
  name: string;
  description: string;
  enabled: boolean;
};

type SlashCommandDefinition = SlashCommandOption & {
  action: Exclude<SlashCommandAction, { type: "unknown" }>;
};

const SLASH_COMMAND_DEFINITIONS: SlashCommandDefinition[] = [
  {
    name: "/exit",
    description: "Exit TUI",
    enabled: true,
    action: { type: "exit" },
  },
  {
    name: "/context",
    description: "Show agent context",
    enabled: true,
    action: { type: "open_context" },
  },
  {
    name: "/force_abort",
    description: "Force abort current run and clear queue",
    enabled: true,
    action: { type: "force_abort" },
  },
  {
    name: "/help",
    description: "Hidden in conversation layout",
    enabled: false,
    action: { type: "hidden", message: "/help hidden in conversation layout" },
  },
  {
    name: "/messages",
    description: "Hidden in conversation layout",
    enabled: false,
    action: { type: "hidden", message: "/messages hidden in conversation layout" },
  },
];

export const SLASH_COMMANDS: SlashCommandOption[] = SLASH_COMMAND_DEFINITIONS.map(
  ({ name, description, enabled }) => ({
    name,
    description,
    enabled,
  }),
);

export const filterEnabledSlashCommands = (query: string): SlashCommandOption[] => {
  const normalized = query.trim().toLowerCase();
  const enabled = SLASH_COMMAND_DEFINITIONS.filter((cmd) => cmd.enabled);
  if (!normalized) return enabled;
  return enabled.filter((cmd) => cmd.name.toLowerCase().includes(normalized));
};

export const resolveSlashCommandAction = (command: string): SlashCommandAction => {
  const matched = SLASH_COMMAND_DEFINITIONS.find((item) => item.name === command);
  if (!matched) {
    return {
      type: "unknown",
      message: `Unknown command: ${command}`,
    };
  }

  return matched.action;
};
