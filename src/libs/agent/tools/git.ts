/**
 * Git CLI 工具（运行时检查 git 是否可用）
 */

import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type GitToolInput = {
  cwd: string;
  subcommand: string;
  args?: string[];
};

let gitAvailabilityCache: boolean | null = null;

const checkGitAvailable = async (): Promise<boolean> => {
  if (gitAvailabilityCache !== null) {
    return gitAvailabilityCache;
  }

  try {
    const proc = Bun.spawn(["git", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    gitAvailabilityCache = exitCode === 0;
  } catch {
    gitAvailabilityCache = false;
  }

  return gitAvailabilityCache;
};

export const resetGitAvailabilityCacheForTest = () => {
  gitAvailabilityCache = null;
};

export const setGitAvailabilityCacheForTest = (value: boolean | null) => {
  gitAvailabilityCache = value;
};

export const gitTool = (context: ToolExecutionContext) =>
  tool({
    description: "Run git subcommand in a directory by using git CLI",
    inputSchema: z.object({
      cwd: z.string().describe("the absolute path used as git working directory"),
      subcommand: z.string().describe("git subcommand, e.g. status/log/diff"),
      args: z
        .array(z.string())
        .optional()
        .describe("additional git args as string array"),
    }),
    execute: async ({ cwd, subcommand, args = [] }: GitToolInput) => {
      const policy = createPermissionPolicy(context);
      if (!policy.canUseGit(cwd)) {
        return {
          error: "Permission denied: git path not allowed",
        };
      }

      const commandArgs = ["git", subcommand, ...args];
      const command = commandArgs.join(" ");
      if (policy.hasSensitivePathReference(command, cwd)) {
        return {
          error: "Permission denied: git command references protected path",
        };
      }

      if (!(await checkGitAvailable())) {
        return {
          error: "git command is not available in runtime environment",
          hint: "Install git in the runtime environment or remove git tool usage.",
        };
      }

      try {
        const proc = Bun.spawn(commandArgs, {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });

        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        if (exitCode !== 0) {
          return {
            error: stderr || "git command failed",
            cwd,
            command,
            stdout,
            stderr,
            exitCode,
          };
        }

        return {
          success: true,
          cwd,
          command,
          stdout,
          stderr,
          exitCode,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "git command failed",
          cwd,
          command,
        };
      }
    },
  });
