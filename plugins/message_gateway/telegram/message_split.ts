export const splitTelegramMessage = (text: string, chunkSize: number): string[] => {
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0");
  }

  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + chunkSize, text.length);
    if (end < text.length && text[end - 1] === "\\") {
      end -= 1;
      if (end <= index) {
        end = Math.min(index + 2, text.length);
      }
    }

    chunks.push(text.slice(index, end));
    index = end;
  }

  return chunks;
};
