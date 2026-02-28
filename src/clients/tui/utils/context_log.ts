import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentContextResponse } from "../../../types/http";

const sanitizeTimestampToken = (input: string): string =>
  input.replace(/[^0-9]/g, "").slice(0, 14);

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const buildContextLogTimestamp = (now = new Date()): string =>
  [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds()),
  ].join("");

export const buildContextLogFilepath = (
  workspace: string,
  now = new Date(),
): string => {
  const normalizedWorkspace = resolve(workspace);
  const token = sanitizeTimestampToken(buildContextLogTimestamp(now));
  return join(normalizedWorkspace, ".agent", "log", `context_${token}.log`);
};

export const saveContextLog = async (args: {
  workspace: string;
  contextBody: string;
  now?: Date;
}): Promise<string> => {
  const filepath = buildContextLogFilepath(args.workspace, args.now ?? new Date());
  await mkdir(resolve(args.workspace, ".agent", "log"), { recursive: true });
  await writeFile(filepath, args.contextBody, "utf8");
  return filepath;
};

export const buildContextLogPayload = (args: {
  contextResponse: AgentContextResponse;
  savedAt?: Date;
}): string =>
  JSON.stringify({
    saved_at: (args.savedAt ?? new Date()).toISOString(),
    context: args.contextResponse.context,
    injectedContext: args.contextResponse.injectedContext,
    projectionDebug: args.contextResponse.projectionDebug,
  }, null, 2);
