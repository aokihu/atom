/**
 * 列出目录文件
 */

import { $ } from "bun";
import { tool } from "ai";
import { z } from "zod";
import { canListDir } from "./permissions";

export const lsTool = (context: any) =>
  tool({
    description:
      "List files in a directory by using ls command, tail slash is need",
    inputSchema: z.object({
      dirpath: z.string().describe("the absolute path of directory"),
      all: z.boolean().optional().describe("list hidden files when true"),
      long: z
        .boolean()
        .optional()
        .describe("use long listing format when true"),
    }),
    execute: async ({ dirpath, all = false, long = false }) => {
      if (!canListDir(dirpath, context?.permissions?.tools)) {
        return {
          error: "Permission denied: ls path not allowed",
        };
      }

      const command = ["ls", all ? "-a" : "", long ? "-l" : "", dirpath]
        .filter(Boolean)
        .join(" ");

      try {
        let result = "";
        if (all && long) {
          result = await $`ls -a -l ${dirpath}`.text();
        } else if (all) {
          result = await $`ls -a ${dirpath}`.text();
        } else if (long) {
          result = await $`ls -l ${dirpath}`.text();
        } else {
          result = await $`ls ${dirpath}`.text();
        }

        return {
          dirpath,
          command,
          output: result,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "ls command failed",
          command,
        };
      }
    },
  });
