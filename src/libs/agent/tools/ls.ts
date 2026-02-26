/**
 * 列出目录文件
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";

type LsToolInput = {
  dirpath: string;
  all?: boolean;
  long?: boolean;
};

type LsListEntry = {
  name: string;
  fullPath: string;
};

type LsLongRow = {
  mode: string;
  nlink: string;
  uid: string;
  gid: string;
  size: string;
  mtime: string;
  name: string;
};

const sortDirEntriesByName = (entries: Dirent[]) =>
  [...entries].sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

const pad2 = (value: number) => value.toString().padStart(2, "0");

const formatTimestamp = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

const getFileTypeChar = (stats: Stats) => {
  if (stats.isDirectory()) return "d";
  if (stats.isFile()) return "-";
  if (stats.isSymbolicLink()) return "l";
  return "?";
};

const formatMode = (stats: Stats) => {
  const mode = stats.mode ?? 0;
  const perms = [
    0o400, 0o200, 0o100,
    0o040, 0o020, 0o010,
    0o004, 0o002, 0o001,
  ];
  const symbols = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  const permissionChars = perms.map((bit, index) => (mode & bit ? symbols[index] : "-"));
  return `${getFileTypeChar(stats)}${permissionChars.join("")}`;
};

const toNumberField = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : "-";

const toOutputText = (lines: string[]) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

const isErrnoError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const mapStatDirectoryError = (error: unknown) => {
  if (isErrnoError(error)) {
    if (error.code === "ENOENT") return "Directory path does not exist";
    if (error.code === "ENOTDIR") return "Path is not a directory";
    if (error.code === "EACCES" || error.code === "EPERM") {
      return "Permission denied: unable to read directory";
    }
  }
  return error instanceof Error ? error.message : "ls operation failed";
};

const mapReaddirError = (error: unknown) => {
  if (isErrnoError(error)) {
    if (error.code === "EACCES" || error.code === "EPERM") {
      return "Permission denied: unable to read directory";
    }
    if (error.code === "ENOENT") {
      return "Directory path does not exist";
    }
    if (error.code === "ENOTDIR") {
      return "Path is not a directory";
    }
  }
  return error instanceof Error ? error.message : "ls operation failed";
};

const buildVisibleEntries = async (
  dirpath: string,
  all: boolean,
  shouldHideDirEntry: (dirpath: string, name: string) => boolean,
) => {
  let entries = await readdir(dirpath, { withFileTypes: true });
  if (!all) {
    entries = entries.filter((entry) => !entry.name.startsWith("."));
  }
  entries = entries.filter((entry) => !shouldHideDirEntry(dirpath, entry.name));
  entries = sortDirEntriesByName(entries);

  const result: LsListEntry[] = entries.map((entry) => ({
    name: entry.name,
    fullPath: join(dirpath, entry.name),
  }));

  if (all) {
    result.unshift(
      { name: ".", fullPath: dirpath },
      { name: "..", fullPath: dirname(dirpath) },
    );
  }

  return result;
};

const getLongDisplayName = async (name: string, fullPath: string, stats: Stats) => {
  if (!stats.isSymbolicLink()) {
    return name;
  }

  try {
    const target = await readlink(fullPath);
    return `${name} -> ${target}`;
  } catch {
    return `${name} -> [unreadable]`;
  }
};

const buildLongRows = async (entries: LsListEntry[]) => {
  const rows = await Promise.all(
    entries.map(async ({ name, fullPath }): Promise<LsLongRow> => {
      const entryStat = await lstat(fullPath);
      return {
        mode: formatMode(entryStat),
        nlink: toNumberField(entryStat.nlink),
        uid: toNumberField((entryStat as { uid?: number }).uid),
        gid: toNumberField((entryStat as { gid?: number }).gid),
        size: toNumberField(entryStat.size),
        mtime: formatTimestamp(entryStat.mtime),
        name: await getLongDisplayName(name, fullPath, entryStat),
      };
    }),
  );

  const widths = rows.reduce(
    (acc, row) => ({
      nlink: Math.max(acc.nlink, row.nlink.length),
      uid: Math.max(acc.uid, row.uid.length),
      gid: Math.max(acc.gid, row.gid.length),
      size: Math.max(acc.size, row.size.length),
    }),
    { nlink: 1, uid: 1, gid: 1, size: 1 },
  );

  return rows.map(
    (row) =>
      `${row.mode} ${row.nlink.padStart(widths.nlink, " ")} ${row.uid.padStart(widths.uid, " ")} ${row.gid.padStart(widths.gid, " ")} ${row.size.padStart(widths.size, " ")} ${row.mtime} ${row.name}`,
  );
};

export const lsTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "List files in a directory using built-in filesystem APIs, tail slash is need",
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
        let dirStat: Stats;
        try {
          dirStat = await stat(dirpath);
        } catch (error) {
          return {
            error: mapStatDirectoryError(error),
            command,
          };
        }

        if (!dirStat.isDirectory()) {
          return {
            error: "Path is not a directory",
            command,
          };
        }

        let entries: LsListEntry[];
        try {
          entries = await buildVisibleEntries(
            dirpath,
            all,
            (parent, name) => policy.shouldHideDirEntry(parent, name),
          );
        } catch (error) {
          return {
            error: mapReaddirError(error),
            command,
          };
        }

        const lines = long
          ? await buildLongRows(entries)
          : entries.map((entry) => entry.name);
        const output = toOutputText(lines);

        return {
          dirpath,
          command,
          output,
          method: "builtin.fs",
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "ls operation failed",
          command,
        };
      }
    },
  });
