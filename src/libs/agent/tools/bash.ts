import { tool } from "ai";
import { z } from "zod";
import { createPermissionPolicy } from "./permissions/policy";
import type { ToolExecutionContext } from "./types";
import { validateBashCommandSafety } from "./bash_command_guard";
import {
  getNormalBashSessionCwd,
  hasNormalBashSession,
  killNormalBashSession,
  queryNormalBashSession,
  startNormalBashSession,
} from "./bash_sessions";
import {
  checkBashAvailable,
  clampQueryMaxItems,
  decodeNormalCursor,
  DEFAULT_NORMAL_IDLE_TIMEOUT_MS,
  encodeNormalCursor,
  generateBashSessionId,
  isAbsolutePathString,
  isValidBashSessionId,
  validateExistingDirectory,
} from "./bash_utils";

const startActionSchema = z.object({
  action: z.literal("start"),
  mode: z.enum(["once", "normal", "background"]),
  cwd: z.string().optional().describe("absolute working directory path, defaults to tool workspace"),
  command: z.string().min(1).describe("bash command string"),
  sessionId: z.string().optional().describe("session id for normal mode"),
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

const sensitivePathDenied = () => ({
  error: "Permission denied: bash command references protected path",
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

const queryBashSession = async (
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

  return {
    error: "Session not found",
    sessionId,
    status: "not_found" as const,
  };
};

const killBashSession = async (
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

  return {
    error: "Session not found",
    sessionId,
    status: "not_found" as const,
  };
};

export const bashTool = (context: ToolExecutionContext) =>
  tool({
    description:
      "Run bash commands in once/normal modes, then query or kill normal sessions.",
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

        return await killBashSession(policy, killInput.sessionId, killInput.force ?? false);
      }

      const parsed = startActionSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid input", formatZodInputError(parsed.error));
      }
      const startInput: BashToolInput = parsed.data;

      const { command, mode } = startInput;

      if (mode === "background") {
        return {
          error: "bash background mode has been removed",
          hint: "Use the 'background' tool instead",
        };
      }

      const cwd = startInput.cwd ?? context.workspace;
      if (typeof cwd !== "string" || cwd.trim() === "") {
        return invalidInput("Invalid cwd", "cwd is required when workspace is unavailable");
      }

      if (!isAbsolutePathString(cwd)) {
        return invalidInput("Invalid cwd", "cwd must be an absolute path");
      }

      if (!policy.canUseBash(cwd)) {
        return permissionDenied();
      }

      const cwdCheck = await validateExistingDirectory(cwd);
      if (!cwdCheck.ok) {
        return invalidInput("Invalid cwd", cwdCheck.error);
      }

      const safety = validateBashCommandSafety(command);
      if (!safety.ok) {
        return commandBlocked(safety.ruleId, safety.message);
      }

      if (policy.hasSensitivePathReference(command, cwd)) {
        return sensitivePathDenied();
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

      if (mode === "normal") {
        return await startNormalBashSession({
          sessionId,
          cwd,
          command,
          idleTimeoutMs: startInput.idleTimeoutMs ?? DEFAULT_NORMAL_IDLE_TIMEOUT_MS,
        });
      }

      return invalidInput("Invalid input", "mode must be 'once' or 'normal'");
    },
  });
