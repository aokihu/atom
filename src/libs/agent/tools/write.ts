/**
 * 写入文件
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.0
 * @description 写入文件内容
 */

import { tool } from "ai";
import { z } from "zod";
import { canWriteFile } from "./permissions";

export const writeTool = (context: any) =>
  tool({
    description: "Write content to a file",
    inputSchema: z.object({
      filepath: z.string().describe("the absolute path of file"),
      content: z.string().describe("the file content to write"),
      append: z.boolean().optional().describe("append to file if true"),
    }),
    execute: async ({ filepath, content, append = false }) => {
      if (!canWriteFile(filepath, context?.permissions?.tools)) {
        return {
          error: "Permission denied: write path not allowed",
        };
      }

      const file = Bun.file(filepath);
      const text = append && (await file.exists())
        ? `${await file.text()}${content}`
        : content;

      await Bun.write(filepath, text);

      return {
        success: true,
        filepath,
        bytes: Buffer.byteLength(text),
        append,
      };
    },
  });
