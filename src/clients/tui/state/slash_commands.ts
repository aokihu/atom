/**
 * Slash command registry for TUI.
 *
 * Purpose:
 * - Define built-in slash commands and enabled flags.
 * - Provide query filtering used by slash modal controller.
 */

export type SlashCommandOption = {
  name: string;
  description: string;
  enabled: boolean;
};

export const SLASH_COMMANDS: SlashCommandOption[] = [
  { name: "/exit", description: "Exit TUI", enabled: true },
  { name: "/context", description: "Show agent context", enabled: true },
  { name: "/force_abort", description: "Force abort current run and clear queue", enabled: true },
  { name: "/help", description: "Hidden in conversation layout", enabled: false },
  { name: "/messages", description: "Hidden in conversation layout", enabled: false },
];

export const filterEnabledSlashCommands = (query: string): SlashCommandOption[] => {
  const normalized = query.trim().toLowerCase();
  const enabled = SLASH_COMMANDS.filter((cmd) => cmd.enabled);
  if (!normalized) return enabled;
  return enabled.filter((cmd) => cmd.name.toLowerCase().includes(normalized));
};
