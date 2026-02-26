/**
 * 读取目录树工具
 */

import { readdir, readlink, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  createPermissionPolicy,
  type PermissionPolicy,
} from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type TreeToolInput = {
  dirpath: string;
  level?: number;
  all?: boolean;
};

type TreeCounts = {
  directories: number;
  files: number;
};

const sortEntries = (entries: Dirent[]) =>
  [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

const formatSummary = ({ directories, files }: TreeCounts) => {
  const directoryLabel = directories === 1 ? "directory" : "directories";
  const fileLabel = files === 1 ? "file" : "files";
  return `${directories} ${directoryLabel}, ${files} ${fileLabel}`;
};

const formatEntryName = async (entry: Dirent, fullPath: string) => {
  if (entry.isDirectory()) {
    return `${entry.name}/`;
  }

  if (entry.isSymbolicLink()) {
    try {
      const target = await readlink(fullPath);
      return `${entry.name} -> ${target}`;
    } catch {
      return `${entry.name} -> [unreadable]`;
    }
  }

  return entry.name;
};

const walkTree = async (
  policy: PermissionPolicy,
  dirpath: string,
  depth: number,
  level: number | undefined,
  all: boolean,
  prefix: string,
  counts: TreeCounts,
): Promise<string[]> => {
  let entries = await readdir(dirpath, { withFileTypes: true });
  if (!all) {
    entries = entries.filter((entry) => !entry.name.startsWith("."));
  }
  entries = entries.filter((entry) => !policy.shouldHideDirEntry(dirpath, entry.name));
  entries = sortEntries(entries);

  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const connector = isLast ? "`-- " : "|-- ";
    const childPrefix = `${prefix}${isLast ? "    " : "|   "}`;
    const fullPath = join(dirpath, entry.name);
    const displayName = await formatEntryName(entry, fullPath);

    if (entry.isDirectory()) {
      counts.directories += 1;
      lines.push(`${prefix}${connector}${displayName}`);

      const shouldDescend = level === undefined || depth < level;
      if (shouldDescend) {
        try {
          const childLines = await walkTree(
            policy,
            fullPath,
            depth + 1,
            level,
            all,
            childPrefix,
            counts,
          );
          lines.push(...childLines);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "failed to read directory";
          lines.push(`${childPrefix}\`-- [error: ${message}]`);
        }
      }
      continue;
    }

    counts.files += 1;
    lines.push(`${prefix}${connector}${displayName}`);
  }

  return lines;
};

export const treeTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "Show directory tree using built-in filesystem traversal, need tail slash",
    inputSchema: z.object({
      dirpath: z.string().describe("the absolute path of directory"),
      level: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("max display depth"),
      all: z.boolean().optional().describe("list hidden files when true"),
    }),
    execute: async ({ dirpath, level, all = false }: TreeToolInput) => {
      const policy = createPermissionPolicy(context);
      if (!policy.canReadTree(dirpath)) {
        return {
          error: "Permission denied: tree path not allowed",
        };
      }

      const command = [
        "tree",
        all ? "-a" : "",
        level ? `-L ${level}` : "",
        dirpath,
      ]
        .filter(Boolean)
        .join(" ");

      try {
        const dirStat = await stat(dirpath);
        if (!dirStat.isDirectory()) {
          return {
            error: "Path is not a directory",
            command,
          };
        }

        const counts: TreeCounts = {
          directories: 0,
          files: 0,
        };
        const lines = await walkTree(policy, dirpath, 1, level, all, "", counts);
        const result = [...[dirpath], ...lines, formatSummary(counts)].join("\n");

        return {
          dirpath,
          command,
          output: `${result}\n`,
          method: "builtin.fs",
        };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message : "tree operation failed",
          command,
        };
      }
    },
  });
