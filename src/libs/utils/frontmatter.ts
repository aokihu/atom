/**
 * frontmatter 工具
 * @author aokihu <aokihu@gmail.com>
 * @version 1.0
 * @license BSD
 * @description -<
 * 提供提取Markdown中Frontmatter内容的工具
 * 考虑到性能的原因,Agent的定义文件可能会非常大,一次性读取Markdown文件会浪费资源
 * 因此提供一些工具用来只提取Frontmatter部分的定义数据
 *
 * - extractFrontmatterLimited 通过截断文本的方式规避完全读取所有内容,小文件性能更好
 * - extractFrontmatterStream 通过字节流方式读取
 */

/**
 * 提取Markdown中Frontmaater文本数据
 * @param filePath {string} Markdown文件的绝对路径
 * @returns {Promise<string>}
 */
export async function extractFrontmatterLimited(
  filePath: string,
): Promise<string> {
  const file = Bun.file(filePath);
  const size = Math.min(10240, file.size);
  const text = await file.slice(0, size).text();
  return text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
}

/**
 * Stream方式读取Frontmatter文本数据
 * @param filePath {string} Markdown文件的绝对路径
 * @returns {Promise<stirng>}
 */
export async function extractFrontmatterStream(
  filePath: string,
): Promise<string> {
  const file = Bun.file(filePath);
  const stream = file.stream();
  const decoder = new TextDecoder();

  const SEARCH_START = 0;
  const READ_BODY = 1;

  let state = SEARCH_START;
  let buffer = "";

  const reader = stream.getReader();
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done || !chunk) break;

      buffer += decoder.decode(chunk, { stream: true });

      while (true) {
        if (state === SEARCH_START) {
          // 允许文件开头有 BOM 或空白
          let i = 0;
          while (i < buffer.length && /\s/.test(buffer.charAt(i))) i++;

          if (buffer.slice(i, i + 3) !== "---") {
            return "";
          }

          // 等待完整的起始行
          const lineEnd = buffer.indexOf("\n", i + 3);
          if (lineEnd === -1) break;

          buffer = buffer.slice(lineEnd + 1);
          state = READ_BODY;
        }

        if (state === READ_BODY) {
          // 查找结束标记
          const idx = buffer.indexOf("\n---");
          if (idx !== -1) {
            return buffer.slice(0, idx);
          }
          break;
        }
      }

      // 控制 buffer 大小，防止无限增长
      if (buffer.length > 8192) {
        buffer = buffer.slice(-4096);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return "";
}
