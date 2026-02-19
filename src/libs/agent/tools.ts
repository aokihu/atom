import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT_LENGTH = 20_000;

function clipText(text: string) {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  return `${text.slice(0, MAX_OUTPUT_LENGTH)}\n...[truncated ${text.length - MAX_OUTPUT_LENGTH} chars]`;
}

function resolveFromWorkspace(inputPath: string) {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error("Invalid path");
  }

  return resolve(process.cwd(), inputPath);
}

async function readProcessOutput(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  return new Response(stream).text();
}

async function runApplyPatch(patch: string) {
  const subprocess = Bun.spawn(["git", "apply", "--whitespace=nowarn", "-"], {
    cwd: globalThis.process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  subprocess.stdin.write(patch);
  subprocess.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(subprocess.stdout),
    readProcessOutput(subprocess.stderr),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git apply failed (${exitCode}): ${clipText(stderr) || "unknown error"}`);
  }

  return {
    success: true,
    stdout: clipText(stdout),
    stderr: clipText(stderr),
  };
}

async function runRipgrep(query: string, cwd?: string, globs?: string[]) {
  const targetCwd = cwd ? resolveFromWorkspace(cwd) : globalThis.process.cwd();
  const args = ["rg", "--line-number", "--column", "--color", "never", query];

  for (const glob of globs ?? []) {
    args.push("-g", glob);
  }

  const subprocess = Bun.spawn(args, {
    cwd: targetCwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(subprocess.stdout),
    readProcessOutput(subprocess.stderr),
    subprocess.exited,
  ]);

  if (exitCode > 1) {
    throw new Error(`rg failed (${exitCode}): ${clipText(stderr) || "unknown error"}`);
  }

  return {
    success: true,
    cwd: targetCwd,
    matched: exitCode === 0,
    stdout: clipText(stdout),
    stderr: clipText(stderr),
  };
}

export function createAgentTools() {
  return {
    read: tool({
      description: "Read UTF-8 text from a file in the current workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path relative to workspace root"),
      }),
      execute: async ({ path }) => {
        const resolvedPath = resolveFromWorkspace(path);
        const content = await Bun.file(resolvedPath).text();
        return {
          path: resolvedPath,
          content: clipText(content),
        };
      },
    }),
    write: tool({
      description: "Write UTF-8 text into a file, creating parent directories when needed.",
      inputSchema: z.object({
        path: z.string().describe("Path relative to workspace root"),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        const resolvedPath = resolveFromWorkspace(path);
        await mkdir(dirname(resolvedPath), { recursive: true });
        await Bun.write(resolvedPath, content);

        return {
          success: true,
          path: resolvedPath,
          bytes: Buffer.byteLength(content, "utf-8"),
        };
      },
    }),
    apply_patch: tool({
      description: "Apply a unified diff patch to the current git workspace.",
      inputSchema: z.object({
        patch: z.string().describe("Unified diff content"),
      }),
      execute: async ({ patch }) => runApplyPatch(patch),
    }),
    ripgrep: tool({
      description: "Search files with ripgrep (rg).",
      inputSchema: z.object({
        query: z.string().describe("Pattern supported by ripgrep"),
        cwd: z.string().optional().describe("Optional subdirectory relative to workspace"),
        globs: z.array(z.string()).optional().describe("Optional glob filters, e.g. ['*.ts']"),
      }),
      execute: async ({ query, cwd, globs }) => runRipgrep(query, cwd, globs),
    }),
    webfetch: tool({
      description: "Fetch a webpage using HTTP GET and return response metadata with text body.",
      inputSchema: z.object({
        url: z.string().url(),
        timeoutMs: z.number().int().positive().max(30_000).optional(),
      }),
      execute: async ({ url, timeoutMs }) => {
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs ?? 10_000),
        });

        const body = await response.text();

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          contentType: response.headers.get("content-type"),
          body: clipText(body),
        };
      },
    }),
  };
}
