/**
 * 列出目录文件
 */

import { $ } from "bun";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type LsToolInput = {
  dirpath: string;
  all?: boolean;
  long?: boolean;
};

const AGENT_DIR_NAME = ".agent";

const isLongLsEntryForName = (line: string, name: string) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("total ")) {
    return false;
  }

  return trimmed.endsWith(` ${name}`) || trimmed.includes(` ${name} -> `);
};

const filterLsOutput = (output: string, long: boolean, hideAgentEntry: boolean) => {
  if (!hideAgentEntry) {
    return output;
  }

  const lines = output.split("\n");
  let removedAgent = false;

  let filteredLines = lines.filter((line) => {
    if (long) {
      if (isLongLsEntryForName(line, AGENT_DIR_NAME)) {
        removedAgent = true;
        return false;
      }
      return true;
    }

    if (line === AGENT_DIR_NAME) {
      removedAgent = true;
      return false;
    }

    return true;
  });

  if (long && removedAgent) {
    filteredLines = filteredLines.filter((line, index) =>
      !(index === 0 && /^total\s+\d+\b/.test(line.trim()))
    );
  }

  return filteredLines.join("\n");
};

export const lsTool = (context: ToolExecutionContext) =>
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
    execute: async ({ dirpath, all = false, long = false }: LsToolInput) => {
      const policy = createPermissionPolicy(context);
      if (!policy.canListDir(dirpath)) {
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

        const output = filterLsOutput(
          result,
          long,
          policy.shouldHideDirEntry(dirpath, AGENT_DIR_NAME),
        );

        return {
          dirpath,
          command,
          output,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "ls command failed",
          command,
        };
      }
    },
  });
