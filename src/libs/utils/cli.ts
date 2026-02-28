import { resolve } from "node:path";
import { parseArgs } from "node:util";

export type CliOptions = {
  mode: "tui" | "server" | "tui-client";
  workspace: string;
  configPath?: string;
  httpHost: string;
  httpPort: number;
  serverUrl?: string;
  messageGateway?: string;
};

export const parseCliOptions = (
  argv: string[],
  startupCwd: string,
): CliOptions => {
  let values: {
    workspace?: string;
    config?: string;
    mode?: string;
    "http-host"?: string;
    "http-port"?: string;
    "server-url"?: string;
    "message-gateway"?: string;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        workspace: { type: "string" },
        config: { type: "string" },
        mode: { type: "string" },
        "http-host": { type: "string" },
        "http-port": { type: "string" },
        "server-url": { type: "string" },
        "message-gateway": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values as typeof values;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid CLI arguments. Supported arguments: --workspace, --config, --mode, --http-host, --http-port, --server-url, --message-gateway";
    throw new Error(message);
  }

  const rawMode = values.mode ?? "tui";
  if (
    rawMode !== "hybrid" &&
    rawMode !== "server" &&
    rawMode !== "tui" &&
    rawMode !== "tui-client"
  ) {
    throw new Error(
      "Invalid --mode. Supported values: tui, server, tui-client (legacy alias: hybrid)",
    );
  }

  if (rawMode === "hybrid") {
    console.warn("[startup] `--mode hybrid` is deprecated; use `--mode tui`.");
  }

  const mode: CliOptions["mode"] = rawMode === "hybrid" ? "tui" : rawMode;

  const httpHost = values["http-host"]?.trim() || "127.0.0.1";
  const rawPort = values["http-port"] ?? "8787";
  const httpPort = Number(rawPort);

  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new Error("Invalid --http-port. It must be an integer in range 0..65535");
  }

  const serverUrl = values["server-url"]?.trim();
  if (serverUrl) {
    try {
      new URL(serverUrl);
    } catch {
      throw new Error("Invalid --server-url. It must be a valid absolute URL");
    }
  }

  const messageGateway = values["message-gateway"]?.trim();
  if (messageGateway === "") {
    throw new Error("Invalid --message-gateway. It must be non-empty");
  }

  return {
    mode,
    workspace: resolve(startupCwd, values.workspace ?? "."),
    configPath: values.config ? resolve(startupCwd, values.config) : undefined,
    httpHost,
    httpPort,
    serverUrl,
    messageGateway: messageGateway || undefined,
  };
};
