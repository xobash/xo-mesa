// Report Pi file-tool activity to the authenticated loopback bridge.
// Mirror the binary text-write guard in src/lib/agent.ts; shell writes are outside this guard.
// Without bridge configuration the extension is inactive; reporting failures do not block tools.

import { resolve } from "node:path";
import { existsSync } from "node:fs";

interface PiToolCallEvent {
  toolName?: string;
  input?: { path?: unknown } & Record<string, unknown>;
}

type PiToolCallResult = { block: true; reason: string } | undefined;

interface PiExtensionApi {
  on(event: string, handler: (event: PiToolCallEvent) => PiToolCallResult): void;
}

/** Mirrors `PI_BLOCKED_BINARY_EXTENSIONS` in `src/lib/agent.ts` (the tested
 *  reference). Keep the two in lockstep — this file cannot import it. */
const BLOCKED_BINARY_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "pages", "numbers", "key", "epub", "mobi",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
  "ico", "avif", "heic", "heif", "psd", "ai", "sketch",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "dmg", "iso",
  "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "aiff",
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv",
  "ttf", "otf", "woff", "woff2", "eot",
  "exe", "dll", "dylib", "so", "bin", "wasm", "class", "jar",
  "pyc", "sqlite", "sqlite3", "db",
];

/** Pi built-in tools that write file content from a string payload. `bash` is
 *  intentionally absent: it moves bytes with real tools, not a text encoder. */
const CONTENT_WRITE_TOOLS = ["write", "edit", "apply_patch"];

/** Mirrors `isPiBlockedBinaryPath` in `src/lib/agent.ts`. */
function isBlockedBinaryPath(path: string): boolean {
  const base = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  );
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  return BLOCKED_BINARY_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase());
}

/** Return the binary-write block payload or undefined; keep parity with src/lib/agent.ts. */
function binaryWriteBlock(toolName: string, path: string): PiToolCallResult {
  if (!CONTENT_WRITE_TOOLS.includes(toolName.toLowerCase())) return undefined;
  if (!isBlockedBinaryPath(path)) return undefined;
  return {
    block: true,
    reason:
      `Mesa blocked this write: "${path}" is a binary file, and a text-based ` +
      "write/edit tool cannot round-trip its bytes — the write would corrupt it, " +
      "not change it. Do not retry with different content. Either use a " +
      "format-aware command-line tool via bash (e.g. qpdf, ImageMagick, a " +
      "Python library), or tell the user to make this change in Mesa's own " +
      "editor, which writes binary files safely.",
  };
}

/** Map a Pi built-in tool name to a Mesa activity op, or null to ignore it. */
function opForTool(toolName: string, absPath: string): "read" | "edit" | "write" | "create" | null {
  switch (toolName.toLowerCase()) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "write":
      // Pi's `write` both creates and overwrites; distinguish so the graph can
      // show a "create" burst for brand-new notes and a "write" for existing.
      return existsSync(absPath) ? "write" : "create";
    default:
      // grep / find / ls / bash and any custom tools don't map to a single
      // note node, so we leave them alone.
      return null;
  }
}

export default function mesaActivity(pi: PiExtensionApi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return; // not running inside Mesa — stay silent.

  const cwd = process.env.MESA_VAULT_PATH || process.cwd();
  const endpoint = `http://127.0.0.1:${port}/activity`;

  const report = (op: string, absPath: string): void => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    // Telemetry must never break the agent, so swallow every failure.
    void fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: absPath, op }),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  };

  pi.on("tool_call", (event) => {
    try {
      const toolName = typeof event?.toolName === "string" ? event.toolName : "";
      const rawPath = event?.input?.path;
      if (!toolName || typeof rawPath !== "string" || !rawPath) return undefined;
      let absPath: string;
      try {
        absPath = resolve(cwd, rawPath);
      } catch {
        absPath = rawPath;
      }
      // Decide the block first and return before reporting: a blocked write
      // never happens, so it must not show up as activity in the graph.
      const blocked = binaryWriteBlock(toolName, absPath);
      if (blocked) return blocked;
      const op = opForTool(toolName, absPath);
      if (op) report(op, absPath);
    } catch {
      /* never let activity reporting disrupt a tool call */
    }
    // Every other tool call passes through untouched: Mesa observes, and gates
    // exactly one thing — a text write that would corrupt a binary file.
    return undefined;
  });
}
