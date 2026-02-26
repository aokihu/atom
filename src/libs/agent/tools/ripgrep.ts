/**
 * 使用 ripgrep 搜索目录内容
 */

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

type BuildRipgrepArgsInput = {
  dirpath: string;
  pattern: string;
  caseSensitive?: boolean;
  fileGlob?: string;
  protectedExcludes?: string[];
};

export const buildRipgrepArgs = ({
  dirpath,
  pattern,
  caseSensitive = false,
  fileGlob,
  protectedExcludes = [],
}: BuildRipgrepArgsInput) => {
  const args: string[] = [];

  if (!caseSensitive) {
    args.push("-i");
  }

  if (fileGlob) {
    args.push("-g", fileGlob);
  }

  for (const glob of protectedExcludes) {
    args.push("-g", glob);
  }

  args.push(pattern, dirpath);
  return args;
};

const readSpawnOutput = async (stream: ReadableStream<Uint8Array> | null) => {
  if (!stream) {
    return "";
  }

  return await new Response(stream).text();
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
      const policy = createPermissionPolicy(context);
      if (!policy.canRipgrep(dirpath)) {
        return {
          error: "Permission denied: ripgrep path not allowed",
        };
      }

      const protectedExcludes = policy.getRipgrepExcludeGlobs(dirpath);
      const args = buildRipgrepArgs({
        dirpath,
        pattern,
        caseSensitive,
        fileGlob,
        protectedExcludes,
      });
      const command = ["rg", ...args].join(" ");

      try {
        const process = Bun.spawn(["rg", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });

        const [result, stderr, exitCode] = await Promise.all([
          readSpawnOutput(process.stdout),
          readSpawnOutput(process.stderr),
          process.exited,
        ]);

        if (exitCode !== 0) {
          return {
            error: stderr.trim() || `rg command failed (exit ${exitCode})`,
            command,
          };
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
