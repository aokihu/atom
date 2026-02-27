import { tool } from "ai";
import { z } from "zod";
import { validateBashCommandSafety } from "./bash_command_guard";
import {
  captureBackgroundBashPane,
  createBackgroundBashWindow,
  getBackgroundBashSessionCwd,
  hasBackgroundBashSession,
  inspectBackgroundBashSession,
  killBackgroundBashTarget,
  listBackgroundBashSessions,
  queryBackgroundBashSession,
  sendKeysToBackgroundBashPane,
  splitBackgroundBashPane,
  startBackgroundBashSession,
} from "./background_sessions";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";
import {
  checkBashAvailable,
  checkTmuxAvailable,
  clampQueryMaxItems,
  decodeBackgroundCursor,
  encodeBackgroundCursor,
  generateBashSessionId,
  isAbsolutePathString,
  isValidBashSessionId,
  validateExistingDirectory,
} from "./bash_utils";

const startActionSchema = z.object({
  action: z.literal("start"),
  cwd: z.string().describe("absolute working directory path"),
  command: z.string().min(1).describe("bash command string"),
  sessionId: z.string().optional(),
  windowName: z.string().min(1).optional(),
  paneName: z.string().min(1).optional(),
});

const listActionSchema = z.object({
  action: z.literal("list"),
  includeStopped: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

const inspectActionSchema = z.object({
  action: z.literal("inspect"),
  sessionId: z.string(),
  includePanePreview: z.boolean().optional(),
  previewLines: z.number().int().positive().optional(),
});

const queryLogsActionSchema = z.object({
  action: z.literal("query_logs"),
  sessionId: z.string(),
  cursor: z.string().optional(),
  maxItems: z.number().int().positive().optional(),
});

const capturePaneActionSchema = z.object({
  action: z.literal("capture_pane"),
  sessionId: z.string(),
  paneId: z.string().min(1),
  tailLines: z.number().int().positive().optional(),
  includeAnsi: z.boolean().optional(),
});

const sendKeysActionSchema = z.object({
  action: z.literal("send_keys"),
  sessionId: z.string(),
  paneId: z.string().min(1),
  command: z.string().min(1),
  pressEnter: z.boolean().optional(),
});

const newWindowActionSchema = z.object({
  action: z.literal("new_window"),
  sessionId: z.string(),
  cwd: z.string().optional(),
  command: z.string().min(1).optional(),
  windowName: z.string().min(1).optional(),
});

const splitPaneActionSchema = z.object({
  action: z.literal("split_pane"),
  sessionId: z.string(),
  targetPaneId: z.string().min(1),
  direction: z.enum(["horizontal", "vertical"]),
  cwd: z.string().optional(),
  command: z.string().min(1).optional(),
  size: z.number().int().min(1).max(99).optional(),
});

const killActionSchema = z.object({
  action: z.literal("kill"),
  sessionId: z.string(),
  targetType: z.enum(["session", "window", "pane"]).optional(),
  targetId: z.string().optional(),
  force: z.boolean().optional(),
});

const backgroundInputSchema = z.object({
  action: z.enum([
    "start",
    "list",
    "inspect",
    "query_logs",
    "capture_pane",
    "send_keys",
    "new_window",
    "split_pane",
    "kill",
  ]),
  cwd: z.string().optional(),
  command: z.string().optional(),
  sessionId: z.string().optional(),
  windowName: z.string().optional(),
  paneName: z.string().optional(),
  includeStopped: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  includePanePreview: z.boolean().optional(),
  previewLines: z.number().int().positive().optional(),
  cursor: z.string().optional(),
  maxItems: z.number().int().positive().optional(),
  paneId: z.string().optional(),
  tailLines: z.number().int().positive().optional(),
  includeAnsi: z.boolean().optional(),
  pressEnter: z.boolean().optional(),
  targetPaneId: z.string().optional(),
  direction: z.enum(["horizontal", "vertical"]).optional(),
  size: z.number().int().min(1).max(99).optional(),
  targetType: z.enum(["session", "window", "pane"]).optional(),
  targetId: z.string().optional(),
  force: z.boolean().optional(),
});

type BackgroundToolInput =
  | z.infer<typeof startActionSchema>
  | z.infer<typeof listActionSchema>
  | z.infer<typeof inspectActionSchema>
  | z.infer<typeof queryLogsActionSchema>
  | z.infer<typeof capturePaneActionSchema>
  | z.infer<typeof sendKeysActionSchema>
  | z.infer<typeof newWindowActionSchema>
  | z.infer<typeof splitPaneActionSchema>
  | z.infer<typeof killActionSchema>;

type BackgroundToolSchemaInput = z.infer<typeof backgroundInputSchema>;

const invalidInput = (error: string, detail?: string) => ({
  error,
  ...(detail ? { detail } : {}),
});

const formatZodInputError = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Invalid input";

const permissionDenied = () => ({
  error: "Permission denied: background path not allowed",
});

const commandBlocked = (ruleId: string, detail: string) => ({
  error: "Command blocked by builtin safety policy",
  ruleId,
  detail,
});

const sensitivePathDenied = () => ({
  error: "Permission denied: background command references protected path",
});

const bashUnavailableError = () => ({
  error: "bash command is not available in runtime environment",
});

const tmuxUnavailableError = () => ({
  error: "tmux command is not available in runtime environment",
});

const ensureWorkspace = (context: ToolExecutionContext) => {
  const workspace = context.workspace;
  if (typeof workspace !== "string" || workspace.trim() === "") {
    return { error: "Invalid tool context", detail: "workspace is required for background tool" } as const;
  }
  return { workspace } as const;
};

const ensureSessionId = (provided?: string) => {
  const sessionId = provided ?? generateBashSessionId();
  if (!isValidBashSessionId(sessionId)) {
    return { error: "Invalid sessionId", detail: "sessionId must match /^[a-zA-Z0-9._-]+$/" } as const;
  }
  return { sessionId } as const;
};

const ensureValidSessionId = (sessionId: string) => {
  if (!isValidBashSessionId(sessionId)) {
    return { error: "Invalid sessionId", detail: "sessionId must match /^[a-zA-Z0-9._-]+$/" } as const;
  }
  return { ok: true } as const;
};

const sessionNotFound = (sessionId: string) => ({
  error: "Session not found",
  sessionId,
  status: "not_found" as const,
});

const clampListLimit = (value?: number) => {
  if (!Number.isInteger(value)) return 100;
  if ((value as number) <= 0) return 100;
  return Math.min(value as number, 500);
};

const checkCommandSafety = (command: string) => {
  const safety = validateBashCommandSafety(command);
  if (!safety.ok) {
    return commandBlocked(safety.ruleId, safety.message);
  }
  return null;
};

export const backgroundTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "Manage persistent tmux-backed background sessions: start/list/inspect/query_logs/capture_pane/send_keys/new_window/split_pane/kill.",
    inputSchema: backgroundInputSchema,
    execute: async (input: BackgroundToolSchemaInput) => {
      const policy = createPermissionPolicy(context);
      const workspaceResult = ensureWorkspace(context);
      if ("error" in workspaceResult) {
        return workspaceResult;
      }
      const workspace = workspaceResult.workspace;

      if (input.action === "list") {
        const parsed = listActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const listInput: BackgroundToolInput = parsed.data;
        const limit = clampListLimit(listInput.limit);
        const listResult = await listBackgroundBashSessions({
          workspace,
          includeStopped: listInput.includeStopped,
          limit: 500,
        });
        const sessions = listResult.sessions
          .filter((session) => policy.canUseBackground(session.cwd))
          .slice(0, limit);
        return { sessions };
      }

      if (input.action === "query_logs") {
        const parsed = queryLogsActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const queryInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(queryInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }

        const cwd = await getBackgroundBashSessionCwd(workspace, queryInput.sessionId);
        if (!cwd) return sessionNotFound(queryInput.sessionId);
        if (!policy.canUseBackground(cwd)) return permissionDenied();

        const decoded = decodeBackgroundCursor(queryInput.cursor);
        if (!decoded.ok) {
          return invalidInput("Invalid cursor", decoded.error);
        }

        const result = await queryBackgroundBashSession({
          workspace,
          sessionId: queryInput.sessionId,
          offset: decoded.value,
          maxItems: clampQueryMaxItems(queryInput.maxItems),
        });
        if (!result) return sessionNotFound(queryInput.sessionId);
        if ("error" in result) return result;

        return {
          ...result,
          nextCursor: encodeBackgroundCursor(result.nextOffset),
        };
      }

      if (input.action === "inspect") {
        const parsed = inspectActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const inspectInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(inspectInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }
        const cwd = await getBackgroundBashSessionCwd(workspace, inspectInput.sessionId);
        if (!cwd) return sessionNotFound(inspectInput.sessionId);
        if (!policy.canUseBackground(cwd)) return permissionDenied();

        const result = await inspectBackgroundBashSession({
          workspace,
          sessionId: inspectInput.sessionId,
          includePanePreview: inspectInput.includePanePreview,
          previewLines: inspectInput.previewLines,
        });
        if (!result) return sessionNotFound(inspectInput.sessionId);
        return result;
      }

      if (input.action === "capture_pane") {
        const parsed = capturePaneActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const captureInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(captureInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }
        const cwd = await getBackgroundBashSessionCwd(workspace, captureInput.sessionId);
        if (!cwd) return sessionNotFound(captureInput.sessionId);
        if (!policy.canUseBackground(cwd)) return permissionDenied();

        const result = await captureBackgroundBashPane({
          workspace,
          sessionId: captureInput.sessionId,
          paneId: captureInput.paneId,
          tailLines: captureInput.tailLines,
          includeAnsi: captureInput.includeAnsi,
        });
        if (!result) return sessionNotFound(captureInput.sessionId);
        return result;
      }

      if (input.action === "send_keys") {
        const parsed = sendKeysActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const sendInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(sendInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }
        const cwd = await getBackgroundBashSessionCwd(workspace, sendInput.sessionId);
        if (!cwd) return sessionNotFound(sendInput.sessionId);
        if (!policy.canUseBackground(cwd)) return permissionDenied();

        const blocked = checkCommandSafety(sendInput.command);
        if (blocked) return blocked;
        if (policy.hasSensitivePathReference(sendInput.command, cwd)) {
          return sensitivePathDenied();
        }

        const result = await sendKeysToBackgroundBashPane({
          workspace,
          sessionId: sendInput.sessionId,
          paneId: sendInput.paneId,
          command: sendInput.command,
          pressEnter: sendInput.pressEnter,
        });
        if (!result) return sessionNotFound(sendInput.sessionId);
        return result;
      }

      if (input.action === "new_window") {
        const parsed = newWindowActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const newWindowInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(newWindowInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }
        const sessionCwd = await getBackgroundBashSessionCwd(workspace, newWindowInput.sessionId);
        if (!sessionCwd) return sessionNotFound(newWindowInput.sessionId);

        const cwd = newWindowInput.cwd ?? sessionCwd;
        if (newWindowInput.cwd && !isAbsolutePathString(newWindowInput.cwd)) {
          return invalidInput("Invalid cwd", "cwd must be an absolute path");
        }
        if (!policy.canUseBackground(cwd)) return permissionDenied();
        const cwdCheck = await validateExistingDirectory(cwd);
        if (!cwdCheck.ok) return invalidInput("Invalid cwd", cwdCheck.error);
        if (newWindowInput.command) {
          const blocked = checkCommandSafety(newWindowInput.command);
          if (blocked) return blocked;
          if (policy.hasSensitivePathReference(newWindowInput.command, cwd)) {
            return sensitivePathDenied();
          }
        }

        const result = await createBackgroundBashWindow({
          workspace,
          sessionId: newWindowInput.sessionId,
          cwd: newWindowInput.cwd,
          command: newWindowInput.command,
          windowName: newWindowInput.windowName,
        });
        if (!result) return sessionNotFound(newWindowInput.sessionId);
        return result;
      }

      if (input.action === "split_pane") {
        const parsed = splitPaneActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const splitInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(splitInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }
        const sessionCwd = await getBackgroundBashSessionCwd(workspace, splitInput.sessionId);
        if (!sessionCwd) return sessionNotFound(splitInput.sessionId);

        const cwd = splitInput.cwd ?? sessionCwd;
        if (splitInput.cwd && !isAbsolutePathString(splitInput.cwd)) {
          return invalidInput("Invalid cwd", "cwd must be an absolute path");
        }
        if (!policy.canUseBackground(cwd)) return permissionDenied();
        const cwdCheck = await validateExistingDirectory(cwd);
        if (!cwdCheck.ok) return invalidInput("Invalid cwd", cwdCheck.error);
        if (splitInput.command) {
          const blocked = checkCommandSafety(splitInput.command);
          if (blocked) return blocked;
          if (policy.hasSensitivePathReference(splitInput.command, cwd)) {
            return sensitivePathDenied();
          }
        }

        const result = await splitBackgroundBashPane({
          workspace,
          sessionId: splitInput.sessionId,
          targetPaneId: splitInput.targetPaneId,
          direction: splitInput.direction,
          cwd: splitInput.cwd,
          command: splitInput.command,
          size: splitInput.size,
        });
        if (!result) return sessionNotFound(splitInput.sessionId);
        return result;
      }

      if (input.action === "kill") {
        const parsed = killActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const killInput: BackgroundToolInput = parsed.data;
        const sessionIdCheck = ensureValidSessionId(killInput.sessionId);
        if ("error" in sessionIdCheck) {
          return sessionIdCheck;
        }

        const cwd = await getBackgroundBashSessionCwd(workspace, killInput.sessionId);
        if (!cwd) return sessionNotFound(killInput.sessionId);
        if (!policy.canUseBackground(cwd)) return permissionDenied();

        const result = await killBackgroundBashTarget({
          workspace,
          sessionId: killInput.sessionId,
          targetType: killInput.targetType,
          targetId: killInput.targetId,
          force: killInput.force,
        });
        if (!result) return sessionNotFound(killInput.sessionId);
        return result;
      }

      const parsed = startActionSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid input", formatZodInputError(parsed.error));
      }
      const startInput: BackgroundToolInput = parsed.data;

      if (!isAbsolutePathString(startInput.cwd)) {
        return invalidInput("Invalid cwd", "cwd must be an absolute path");
      }
      if (!policy.canUseBackground(startInput.cwd)) {
        return permissionDenied();
      }
      const cwdCheck = await validateExistingDirectory(startInput.cwd);
      if (!cwdCheck.ok) {
        return invalidInput("Invalid cwd", cwdCheck.error);
      }

      const blocked = checkCommandSafety(startInput.command);
      if (blocked) return blocked;
      if (policy.hasSensitivePathReference(startInput.command, startInput.cwd)) {
        return sensitivePathDenied();
      }

      if (!(await checkBashAvailable())) {
        return bashUnavailableError();
      }
      if (!(await checkTmuxAvailable())) {
        return tmuxUnavailableError();
      }

      const sessionIdResult = ensureSessionId(startInput.sessionId);
      if ("error" in sessionIdResult) {
        return sessionIdResult;
      }
      const sessionId = sessionIdResult.sessionId;
      if (await hasBackgroundBashSession(workspace, sessionId)) {
        return {
          error: "Session already exists",
          sessionId,
          status: "failed_to_start" as const,
        };
      }

      return await startBackgroundBashSession({
        workspace,
        sessionId,
        cwd: startInput.cwd,
        command: startInput.command,
        windowName: startInput.windowName,
        paneName: startInput.paneName,
      });
    },
  });
