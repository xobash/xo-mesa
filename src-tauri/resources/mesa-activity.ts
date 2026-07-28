// Mesa activity bridge — a Pi extension loaded by Mesa's embedded terminal.
//
// Filesystem watchers can see writes but never *reads*. So Mesa cannot tell
// when Pi opens a note to look at it — only when Pi changes one on disk. That is
// why, before this extension, the living graph flickered for agent writes but
// stayed dark for agent reads.
//
// This extension closes that gap at the only layer that is identical across
// every model and provider Pi can drive: Pi's own tool-execution pipeline. Pi
// exposes a `tool_call` event that fires for each built-in `read` / `write` /
// `edit` before it runs, carrying the target path — no matter whether the model
// behind Pi is Claude, GPT, Gemini, a local model, or anything else. We report
// each access to Mesa's loopback activity server, which makes the matching graph
// node flicker and floats a live preview card, exactly like an in-app edit.
//
// The same pre-execution moment also closes the one write path in all of Mesa
// that its own verified-write machinery (`src/lib/verifiedWrite.ts`) cannot
// see: Pi's tools write straight to disk from this external process, with zero
// backup, atomicity, or validation.
//
// For text files that is fine — a text tool round-trips text. For a binary
// file it is not an edit but destruction: `write`/`edit`/`apply_patch` carry
// string content, so reaching disk means a UTF-8 decode/encode cycle that
// mangles every byte sequence that isn't valid UTF-8. On a PDF, one altered
// byte invalidates the xref table and the document stops opening. Mesa cannot
// make an external process write good bytes, so it removes the opportunity:
// those tools are blocked outright on binary paths, with a reason string that
// points the model at the two routes that do work (a format-aware tool via
// `bash`, or Mesa's own editor). `bash` itself is deliberately never blocked.
//
// `piBinaryWriteBlock` in `src/lib/agent.ts` owns and unit-tests this decision;
// this file mirrors the extension list and the predicate by hand, because it is
// a standalone resource compiled into the Rust binary via `include_str!` and
// cannot import anything from `src/lib` at runtime — the same constraint
// `opForTool` below already lives with (its tested twin is `activityOpForTool`).
// `harnessContract.test.ts` asserts the two copies stay in lockstep.
//
// Safety / boundary notes:
//   - No-op unless Mesa injected MESA_ACTIVITY_PORT + MESA_ACTIVITY_TOKEN, so
//     running `pi` outside Mesa (or Mesa loading it with the server down) is
//     completely silent — including the binary-write block below.
//   - Talks only to 127.0.0.1 (loopback). Nothing leaves the machine.
//   - Activity reporting stays fire-and-forget with a hard timeout; it never
//     blocks a tool and never throws into the agent. The only call this
//     extension ever blocks is a content write to a binary file, and it fails
//     closed: any error while deciding leaves the tool call untouched.

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

/**
 * The block payload for a content write that would corrupt a binary file, or
 * undefined to let the call through. Mirrors `piBinaryWriteBlock` in
 * `src/lib/agent.ts`, including the reason text — that string is the model's
 * only feedback, so it names the constraint and the routes that do work.
 */
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
