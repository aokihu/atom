import { resolve } from "node:path";
import { parseArgs } from "node:util";

export type CliOptions = {
  workspace: string;
  configPath?: string;
};

export const parseCliOptions = (
  argv: string[],
  startupCwd: string,
): CliOptions => {
  let values: { workspace?: string; config?: string };
  try {
    values = parseArgs({
      args: argv,
      options: {
        workspace: { type: "string" },
        config: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values as { workspace?: string; config?: string };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid CLI arguments. Supported arguments: --workspace, --config";
    throw new Error(message);
  }

  return {
    workspace: resolve(startupCwd, values.workspace ?? "."),
    configPath: values.config ? resolve(startupCwd, values.config) : undefined,
  };
};
