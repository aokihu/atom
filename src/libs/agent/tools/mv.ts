/**
 * 移动文件或目录（优先使用 Bun/文件系统 API）
 */

import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type MvToolInput = {
  source: string;
  destination: string;
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

export const mvTool = (context: ToolExecutionContext) =>
  tool({
    description: "Move file or directory using filesystem APIs",
    inputSchema: z.object({
      source: z.string().describe("the absolute source path"),
      destination: z.string().describe("the absolute destination path"),
      overwrite: z
        .boolean()
        .optional()
        .describe("overwrite destination when true"),
    }),
    execute: async ({
      source,
      destination,
      overwrite = false,
    }: MvToolInput) => {
      const policy = createPermissionPolicy(context);
      if (!policy.canMoveFrom(source) || !policy.canMoveTo(destination)) {
        return {
          error: "Permission denied: mv path not allowed",
        };
      }

      try {
        await stat(source);
      } catch {
        return {
          error: "Source path does not exist",
        };
      }

      if ((await exists(destination)) && !overwrite) {
        return {
          error: "Destination already exists, set overwrite=true to replace",
        };
      }

      try {
        const sourceStat = await stat(source);

        if (overwrite && (await exists(destination))) {
          await rm(destination, { recursive: true, force: true });
        }

        try {
          await rename(source, destination);
        } catch (error) {
          const isCrossDeviceError =
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EXDEV";

          if (!isCrossDeviceError) {
            throw error;
          }

          if (sourceStat.isDirectory()) {
            await copyDirectoryRecursive(source, destination);
            await rm(source, { recursive: true, force: true });
          } else {
            await Bun.write(destination, Bun.file(source));
            await unlink(source);
          }
        }

        return {
          success: true,
          source,
          destination,
          overwrite,
          method: "fs.rename",
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "mv operation failed",
        };
      }
    },
  });
