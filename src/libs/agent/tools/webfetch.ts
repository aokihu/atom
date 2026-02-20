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
import { canVisitUrl } from "./permissions";

export const webfetchTool = (context: any) =>
  tool({
    description: "从网络获取内容",
    inputSchema: z.object({
      url: z.string().describe("需要获取内容的url"),
    }),
    execute: async ({ url }) => {
      try {
        new URL(url);
      } catch {
        return {
          error: "Invalid URL",
        };
      }

      if (!canVisitUrl(url, context?.permissions?.tools)) {
        return {
          error: "Permission denied: URL not allowed",
        };
      }

      const result = await $`curl -L --max-time 20 ${url}`.text();
      return result;
    },
  });
