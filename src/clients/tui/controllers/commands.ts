export type SlashCommandAction =
  | { type: "exit" }
  | { type: "open_context" }
  | { type: "hidden"; message: string }
  | { type: "unknown"; message: string };

export const resolveSlashCommandAction = (command: string): SlashCommandAction => {
  if (command === "/exit") {
    return { type: "exit" };
  }

  if (command === "/context") {
    return { type: "open_context" };
  }

  if (command === "/help" || command === "/messages") {
    return {
      type: "hidden",
      message: `${command} hidden in conversation layout`,
    };
  }

  return {
    type: "unknown",
    message: `Unknown command: ${command}`,
  };
};
