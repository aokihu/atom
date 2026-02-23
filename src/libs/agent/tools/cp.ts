/**
 * 复制文件或目录（优先使用 Bun 文件 API）
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type CpToolInput = {
  source: string;
  destination: string;
  recursive?: boolean;
  overwrite?: boolean;
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const copyDirectoryRecursive = async (source: string, destination: string) => {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destinationPath);
      continue;
    }

    if (entry.isFile()) {
      await Bun.write(destinationPath, Bun.file(sourcePath));
      continue;
    }

    throw new Error(`Unsupported filesystem entry type: ${sourcePath}`);
  }
};

export const cpTool = (context: ToolExecutionContext) =>
  tool({
    description: "Copy file or directory using Bun filesystem APIs",
    inputSchema: z.object({
      source: z.string().describe("the absolute source path"),
      destination: z.string().describe("the absolute destination path"),
      recursive: z
        .boolean()
        .optional()
        .describe("copy directories recursively when true"),
      overwrite: z
        .boolean()
        .optional()
        .describe("overwrite destination when true"),
    }),
    execute: async ({
      source,
      destination,
      recursive = false,
      overwrite = false,
    }: CpToolInput) => {
      const policy = createPermissionPolicy(context);
      if (!policy.canCopyFrom(source) || !policy.canCopyTo(destination)) {
        return {
          error: "Permission denied: cp path not allowed",
        };
      }

      let sourceStat;
      try {
        sourceStat = await stat(source);
      } catch {
        return {
          error: "Source path does not exist",
        };
      }

      if (await exists(destination)) {
        if (!overwrite) {
          return {
            error: "Destination already exists, set overwrite=true to replace",
          };
        }
      }

      if (sourceStat.isDirectory() && !recursive) {
        return {
          error: "Source is a directory, set recursive=true to copy directories",
        };
      }

      try {
        if (overwrite && (await exists(destination))) {
          await rm(destination, { recursive: true, force: true });
        }

        if (sourceStat.isDirectory()) {
          await copyDirectoryRecursive(source, destination);
        } else {
          await Bun.write(destination, Bun.file(source));
        }

        return {
          success: true,
          source,
          destination,
          recursive,
          overwrite,
          method: "bun.fs",
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "cp operation failed",
        };
      }
    },
  });
