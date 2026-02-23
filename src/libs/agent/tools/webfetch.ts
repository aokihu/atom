/**
 * 从网络获取内容
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.0
 * @description 从网络获取内容,使用bun内置的fetch方法实现
 */

import { $ } from "bun";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type WebfetchToolInput = {
  url: string;
};

export const webfetchTool = (context: ToolExecutionContext) =>
  tool({
    description: "从网络获取内容",
    inputSchema: z.object({
      url: z.string().describe("需要获取内容的url"),
    }),
    execute: async ({ url }: WebfetchToolInput) => {
      try {
        new URL(url);
      } catch {
        return {
          error: "Invalid URL",
        };
      }

      if (!createPermissionPolicy(context).canVisitUrl(url)) {
        return {
          error: "Permission denied: URL not allowed",
        };
      }

      const result = await $`curl -L --max-time 20 ${url}`.text();
      return result;
    },
  });
