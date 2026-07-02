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
// Safety / boundary notes:
//   - No-op unless Mesa injected MESA_ACTIVITY_PORT + MESA_ACTIVITY_TOKEN, so
//     running `pi` outside Mesa (or Mesa loading it with the server down) is
//     completely silent.
//   - Talks only to 127.0.0.1 (loopback). Nothing leaves the machine.
//   - Fire-and-forget with a hard timeout; it never blocks a tool, never throws
//     into the agent, and never changes tool behaviour (it returns nothing, so
//     it cannot block a tool call).

import { resolve } from "node:path";
import { existsSync } from "node:fs";

interface PiToolCallEvent {
  toolName?: string;
  input?: { path?: unknown } & Record<string, unknown>;
}

interface PiExtensionApi {
  on(event: string, handler: (event: PiToolCallEvent) => void): void;
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
      if (!toolName || typeof rawPath !== "string" || !rawPath) return;
      let absPath: string;
      try {
        absPath = resolve(cwd, rawPath);
      } catch {
        absPath = rawPath;
      }
      const op = opForTool(toolName, absPath);
      if (op) report(op, absPath);
    } catch {
      /* never let activity reporting disrupt a tool call */
    }
    // Intentionally return nothing: returning `{ block: true }` would block the
    // tool. Mesa only observes; it never gates Pi's tools.
  });
}
