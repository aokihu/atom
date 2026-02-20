/**
 * 读取目录树工具
 */

import { $ } from "bun";
import { tool } from "ai";
import { z } from "zod";
import { canReadTree } from "./permissions";

export const treeTool = (context: any) =>
  tool({
    description: "Show directory tree by using tree command",
    inputSchema: z.object({
      dirpath: z.string().describe("the absolute path of directory"),
      level: z.number().int().positive().optional().describe("max display depth"),
      all: z.boolean().optional().describe("list hidden files when true"),
    }),
    execute: async ({ dirpath, level, all = false }) => {
      if (!canReadTree(dirpath, context?.permissions?.tools)) {
        return {
          error: "Permission denied: tree path not allowed",
        };
      }

      const command = ["tree", all ? "-a" : "", level ? `-L ${level}` : "", dirpath]
        .filter(Boolean)
        .join(" ");

      try {
        let result = "";
        if (all && level) {
          result = await $`tree -a -L ${level} ${dirpath}`.text();
        } else if (all) {
          result = await $`tree -a ${dirpath}`.text();
        } else if (level) {
          result = await $`tree -L ${level} ${dirpath}`.text();
        } else {
          result = await $`tree ${dirpath}`.text();
        }

        return {
          dirpath,
          command,
          output: result,
        };
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : "tree command failed (maybe tree is not installed)",
          command,
        };
      }
    },
  });
