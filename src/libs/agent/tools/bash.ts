import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";
import { validateBashCommandSafety } from "./bash_command_guard";
import {
  getBackgroundBashSessionCwd,
  hasBackgroundBashSession,
  killBackgroundBashSession,
  queryBackgroundBashSession,
  startBackgroundBashSession,
} from "./bash_background";
import {
  getNormalBashSessionCwd,
  hasNormalBashSession,
  killNormalBashSession,
  queryNormalBashSession,
  startNormalBashSession,
} from "./bash_sessions";
import {
  checkBashAvailable,
  checkTmuxAvailable,
  clampQueryMaxItems,
  decodeBackgroundCursor,
  decodeNormalCursor,
  DEFAULT_NORMAL_IDLE_TIMEOUT_MS,
  encodeBackgroundCursor,
  encodeNormalCursor,
  generateBashSessionId,
  isAbsolutePathString,
  isValidBashSessionId,
} from "./bash_utils";

const startActionSchema = z.object({
  action: z.literal("start"),
  mode: z.enum(["once", "normal", "background"]),
  cwd: z.string().describe("absolute working directory path"),
  command: z.string().min(1).describe("bash command string"),
  sessionId: z.string().optional().describe("session id for normal/background modes"),
  idleTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("idle timeout in ms for normal mode, default 60000"),
});

const queryActionSchema = z.object({
  action: z.literal("query"),
  sessionId: z.string(),
  cursor: z.string().optional(),
  maxItems: z.number().int().positive().optional(),
});

const killActionSchema = z.object({
  action: z.literal("kill"),
  sessionId: z.string(),
  force: z.boolean().optional(),
});

const bashInputSchema = z.object({
  action: z.enum(["start", "query", "kill"]),
  mode: z.enum(["once", "normal", "background"]).optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
  sessionId: z.string().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  cursor: z.string().optional(),
  maxItems: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

type BashToolInput =
  | z.infer<typeof startActionSchema>
  | z.infer<typeof queryActionSchema>
  | z.infer<typeof killActionSchema>;
type BashToolSchemaInput = z.infer<typeof bashInputSchema>;

const invalidInput = (error: string, detail?: string) => ({
  error,
  ...(detail ? { detail } : {}),
});

const formatZodInputError = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Invalid input";

const permissionDenied = () => ({
  error: "Permission denied: bash path not allowed",
});

const commandBlocked = (ruleId: string, detail: string) => ({
  error: "Command blocked by builtin safety policy",
  ruleId,
  detail,
});

const tmuxUnavailableError = () => ({
  error: "tmux command is not available in runtime environment",
});

const bashUnavailableError = () => ({
  error: "bash command is not available in runtime environment",
});

const ensureSessionId = (provided?: string) => {
  const sessionId = provided ?? generateBashSessionId();
  if (!isValidBashSessionId(sessionId)) {
    return { error: "Invalid sessionId", detail: "sessionId must match /^[a-zA-Z0-9._-]+$/" } as const;
  }
  return { sessionId } as const;
};

const runOnceCommand = async (cwd: string, command: string) => {
  const startedAt = Date.now();

  try {
    const output = await Bun.$`bash -lc ${command}`.cwd(cwd).quiet().nothrow();
    const durationMs = Date.now() - startedAt;
    const stdout = output.stdout.toString();
    const stderr = output.stderr.toString();
    const success = output.exitCode === 0;

    return {
      mode: "once" as const,
      cwd,
      command,
      success,
      exitCode: output.exitCode,
      stdout,
      stderr,
      durationMs,
      ...(success ? {} : { error: stderr || `Command exited with code ${output.exitCode}` }),
    };
  } catch (error) {
    return {
      mode: "once" as const,
      cwd,
      command,
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "bash command failed",
    };
  }
};

const isBackgroundLookupPossible = (context: ToolExecutionContext) =>
  typeof context.workspace === "string" && context.workspace.trim() !== "";

const queryBashSession = async (
  context: ToolExecutionContext,
  policy: ReturnType<typeof createPermissionPolicy>,
  sessionId: string,
  cursor: string | undefined,
  maxItems: number,
) => {
  const normalCwd = getNormalBashSessionCwd(sessionId);
  if (normalCwd) {
    if (!policy.canUseBash(normalCwd)) {
      return permissionDenied();
    }

    const decoded = decodeNormalCursor(cursor);
    if (!decoded.ok) {
      return invalidInput("Invalid cursor", decoded.error);
    }

    const result = queryNormalBashSession({
      sessionId,
      afterSeq: decoded.value,
      maxItems,
    });
    if (!result) {
      return {
        error: "Session not found",
        sessionId,
        status: "not_found" as const,
      };
    }

    return {
      ...result,
      nextCursor: encodeNormalCursor(result.nextSeq),
    };
  }

  if (!isBackgroundLookupPossible(context)) {
    return {
      error: "Session not found",
      sessionId,
      status: "not_found" as const,
      warning: "workspace is unavailable for background session lookup",
    };
  }

  const workspace = context.workspace!;
  const backgroundCwd = await getBackgroundBashSessionCwd(workspace, sessionId);
  if (!backgroundCwd) {
    return {
      error: "Session not found",
      sessionId,
      status: "not_found" as const,
    };
  }

  if (!policy.canUseBash(backgroundCwd)) {
    return permissionDenied();
  }

  const decoded = decodeBackgroundCursor(cursor);
  if (!decoded.ok) {
    return invalidInput("Invalid cursor", decoded.error);
  }

  const result = await queryBackgroundBashSession({
    workspace,
    sessionId,
    offset: decoded.value,
    maxItems,
  });

  if (!result) {
    return {
      error: "Session not found",
      sessionId,
      status: "not_found" as const,
    };
  }
  if ("error" in result) {
    return result;
  }

  return {
    ...result,
    nextCursor: encodeBackgroundCursor(result.nextOffset),
  };
};

const killBashSession = async (
  context: ToolExecutionContext,
  policy: ReturnType<typeof createPermissionPolicy>,
  sessionId: string,
  force: boolean,
) => {
  const normalCwd = getNormalBashSessionCwd(sessionId);
  if (normalCwd) {
    if (!policy.canUseBash(normalCwd)) {
      return permissionDenied();
    }

    const result = await killNormalBashSession({ sessionId, force });
    if (!result) {
      return {
        error: "Session not found",
        sessionId,
        status: "not_found" as const,
      };
    }
    return result;
  }

  if (!isBackgroundLookupPossible(context)) {
    return {
      error: "Session not found",
      sessionId,
      status: "not_found" as const,
      warning: "workspace is unavailable for background session lookup",
    };
  }

  const workspace = context.workspace!;
  const backgroundCwd = await getBackgroundBashSessionCwd(workspace, sessionId);
  if (!backgroundCwd) {
    return {
      error: "Session not found",
      sessionId,
      status: "not_found" as const,
    };
  }

  if (!policy.canUseBash(backgroundCwd)) {
    return permissionDenied();
  }

  const result = await killBackgroundBashSession({
    workspace,
    sessionId,
    force,
  });
  if (!result) {
    return {
      error: "Session not found",
      sessionId,
      status: "not_found" as const,
    };
  }
  return result;
};

export const bashTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "Run bash commands in once/normal/background modes, then query or kill non-once sessions.",
    inputSchema: bashInputSchema,
    execute: async (input: BashToolSchemaInput) => {
      const policy = createPermissionPolicy(context);

      if (input.action === "query") {
        const parsed = queryActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const queryInput: BashToolInput = parsed.data;

        if (!isValidBashSessionId(queryInput.sessionId)) {
          return invalidInput("Invalid sessionId", "sessionId must match /^[a-zA-Z0-9._-]+$/");
        }

        return await queryBashSession(
          context,
          policy,
          queryInput.sessionId,
          queryInput.cursor,
          clampQueryMaxItems(queryInput.maxItems),
        );
      }

      if (input.action === "kill") {
        const parsed = killActionSchema.safeParse(input);
        if (!parsed.success) {
          return invalidInput("Invalid input", formatZodInputError(parsed.error));
        }
        const killInput: BashToolInput = parsed.data;

        if (!isValidBashSessionId(killInput.sessionId)) {
          return invalidInput("Invalid sessionId", "sessionId must match /^[a-zA-Z0-9._-]+$/");
        }

        return await killBashSession(context, policy, killInput.sessionId, killInput.force ?? false);
      }

      const parsed = startActionSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid input", formatZodInputError(parsed.error));
      }
      const startInput: BashToolInput = parsed.data;

      const { cwd, command, mode } = startInput;

      if (!isAbsolutePathString(cwd)) {
        return invalidInput("Invalid cwd", "cwd must be an absolute path");
      }

      if (!policy.canUseBash(cwd)) {
        return permissionDenied();
      }

      const safety = validateBashCommandSafety(command);
      if (!safety.ok) {
        return commandBlocked(safety.ruleId, safety.message);
      }

      if (!(await checkBashAvailable())) {
        return bashUnavailableError();
      }

      if (mode === "once") {
        if (startInput.sessionId !== undefined) {
          return invalidInput("Invalid input", "sessionId is not allowed in once mode");
        }
        if (startInput.idleTimeoutMs !== undefined) {
          return invalidInput("Invalid input", "idleTimeoutMs is not allowed in once mode");
        }

        return await runOnceCommand(cwd, command);
      }

      const sessionIdResult = ensureSessionId(startInput.sessionId);
      if ("error" in sessionIdResult) {
        return sessionIdResult;
      }
      const sessionId = sessionIdResult.sessionId;

      if (hasNormalBashSession(sessionId)) {
        return {
          error: "Session already exists",
          sessionId,
          status: "failed_to_start" as const,
        };
      }

      if (isBackgroundLookupPossible(context)) {
        const exists = await hasBackgroundBashSession(context.workspace!, sessionId);
        if (exists) {
          return {
            error: "Session already exists",
            sessionId,
            status: "failed_to_start" as const,
          };
        }
      }

      if (mode === "normal") {
        return await startNormalBashSession({
          sessionId,
          cwd,
          command,
          idleTimeoutMs: startInput.idleTimeoutMs ?? DEFAULT_NORMAL_IDLE_TIMEOUT_MS,
        });
      }

      if (!isBackgroundLookupPossible(context)) {
        return invalidInput("Invalid tool context", "workspace is required for background mode");
      }

      if (!(await checkTmuxAvailable())) {
        return tmuxUnavailableError();
      }

      return await startBackgroundBashSession({
        workspace: context.workspace!,
        sessionId,
        cwd,
        command,
      });
    },
  });
