/**
 * 读取文件工具
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.0
 * @description 读取文件内容
 */

import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type ReadToolInput = {
  filepath: string;
};

export const readTool = (context: ToolExecutionContext) =>
  tool({
    description: "Read file content, include line numbder and content",
    inputSchema: z.object({
      filepath: z.string().describe("the absolute path of file"),
    }),
    execute: async ({ filepath }: ReadToolInput) => {
      if (!createPermissionPolicy(context).canReadFile(filepath)) {
        return {
          error: "Permission denied: read path not allowed",
        };
      }

      const file = Bun.file(filepath);

      // 错误处理
      if (!(await file.exists()))
        return {
          error: "The file is not exists, check filepath",
        };

      const lines = (await file.text())
        .split("\n")
        .map((line: string, idx: number) => [idx, line] as const);

      // 读取文件
      return {
        size: file.size,
        content: lines,
      };
    },
  });
