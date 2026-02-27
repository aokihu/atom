/**
 * TUI command routing helpers.
 *
 * Purpose:
 * - Keep compatibility export surface for command resolver.
 * - Delegate to the single slash-command registry source.
 */

export {
  resolveSlashCommandAction,
  type SlashCommandAction,
} from "../state/slash_commands";
