/**
 * 读取文件工具
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.0
 * @description 读取文件内容
 */

import { tool } from "ai";
import { z } from "zod";

export const readTool = tool({
  description: "Read file content, include line numbder and content",
  inputSchema: z.object({
    filepath: z.string().describe("the absolute path of file"),
  }),
  execute: async ({ filepath }) => {
    const file = Bun.file(filepath);

    // 错误处理
    if (!(await file.exists()))
      return {
        error: "The file is not exists, check filepath",
      };

    const lines = (await file.text())
      .split("\n")
      .map((line, idx) => [idx, line]);

    // 读取文件
    return {
      size: file.size,
      content: lines,
    };
  },
});
