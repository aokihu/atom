const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export const escapeMarkdownV2 = (input: string): string =>
  input.replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$&");
