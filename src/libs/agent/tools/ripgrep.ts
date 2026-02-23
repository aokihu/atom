/**
 * 使用 ripgrep 搜索目录内容
 */

import { $ } from "bun";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type RipgrepToolInput = {
  dirpath: string;
  pattern: string;
  caseSensitive?: boolean;
  fileGlob?: string;
};

export const ripgrepTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "Search file content in directory by using ripgrep, need tail slash",
    inputSchema: z.object({
      dirpath: z.string().describe("the absolute path of directory"),
      pattern: z.string().describe("search pattern used by rg"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("use case-sensitive matching when true"),
      fileGlob: z
        .string()
        .optional()
        .describe("optional glob for filtering files, e.g. *.ts"),
    }),
    execute: async ({
      dirpath,
      pattern,
      caseSensitive = false,
      fileGlob,
    }: RipgrepToolInput) => {
      if (!createPermissionPolicy(context).canRipgrep(dirpath)) {
        return {
          error: "Permission denied: ripgrep path not allowed",
        };
      }

      const command = [
        "rg",
        caseSensitive ? "" : "-i",
        fileGlob ? `-g ${fileGlob}` : "",
        pattern,
        dirpath,
      ]
        .filter(Boolean)
        .join(" ");

      try {
        let result = "";
        if (fileGlob && !caseSensitive) {
          result = await $`rg -i -g ${fileGlob} ${pattern} ${dirpath}`.text();
        } else if (fileGlob) {
          result = await $`rg -g ${fileGlob} ${pattern} ${dirpath}`.text();
        } else if (!caseSensitive) {
          result = await $`rg -i ${pattern} ${dirpath}`.text();
        } else {
          result = await $`rg ${pattern} ${dirpath}`.text();
        }

        return {
          dirpath,
          pattern,
          command,
          output: result,
        };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message : "ripgrep command failed",
          command,
        };
      }
    },
  });
