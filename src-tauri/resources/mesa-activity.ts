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
// The same pre-execution moment also guards against the one write path in all
// of Mesa that its own verified-write machinery (`src/lib/verifiedWrite.ts`)
// cannot see: Pi's tools write straight to disk from this external process,
// so a bad tool call, a hand-rolled extraction script, or a model mistake can
// overwrite a vault file — most visibly a binary file like a PDF, which a
// text-oriented tool is the least equipped to round-trip safely — with zero
// backup, atomicity, or validation. Before a `write`/`edit` tool proceeds
// against a file that already exists, this extension copies its current bytes
// to a dot-prefixed sibling snapshot, invisible to Mesa's scan/watch/sync
// (same skip rule as its own write artifacts) and never auto-restored — that
// stays a deliberate action in Mesa's UI (`restoreLatestAgentSnapshot` in
// `src/lib/vault.ts`, surfaced by `PdfView`'s "Restore previous version").
// `src/lib/agentBackup.ts` owns and unit-tests the naming/retention contract;
// this file mirrors just enough of it by hand to build/prune the same names,
// because it is a standalone resource compiled into the Rust binary via
// `include_str!` and cannot import anything from `src/lib` at runtime — the
// same constraint `opForTool` below already lives with (its tested twin is
// `activityOpForTool` in `src/lib/agent.ts`).
//
// Safety / boundary notes:
//   - No-op unless Mesa injected MESA_ACTIVITY_PORT + MESA_ACTIVITY_TOKEN, so
//     running `pi` outside Mesa (or Mesa loading it with the server down) is
//     completely silent — including the snapshot behaviour below.
//   - Talks only to 127.0.0.1 (loopback). Nothing leaves the machine.
//   - Fire-and-forget with a hard timeout; it never blocks a tool, never throws
//     into the agent, and never changes tool behaviour (it returns nothing, so
//     it cannot block a tool call). The snapshot copy is synchronous but
//     best-effort: any failure is swallowed and never blocks or alters the
//     tool call it is guarding.

import { resolve, dirname, basename, join } from "node:path";
import { existsSync, copyFileSync } from "node:fs";

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

/** Mirrors `buildAgentSnapshotPath` in `src/lib/agentBackup.ts` (the tested
 *  reference) by hand: a dot-prefixed sibling named
 *  `.<base>.mesa-pi-snapshot-<epoch-ms>-<rand>.bak`. Keep the two in
 *  lockstep — this file cannot import the reference implementation. */
function agentSnapshotPath(absPath: string): string {
  const rand = Math.random().toString(36).slice(2);
  const name = `.${basename(absPath)}.mesa-pi-snapshot-${Date.now()}-${rand}.bak`;
  return join(dirname(absPath), name);
}

/**
 * Best-effort defensive copy of `absPath`'s CURRENT on-disk bytes, taken
 * immediately before Pi's own `write`/`edit` tool overwrites it — the one
 * write path in Mesa with no verified-write coverage (see the file header).
 * No-op for a brand-new file (nothing to protect yet). Never throws: a failed
 * snapshot must never block or alter the tool call it is guarding.
 */
function snapshotBeforeWrite(absPath: string): void {
  try {
    if (!existsSync(absPath)) return;
    copyFileSync(absPath, agentSnapshotPath(absPath));
  } catch {
    /* best-effort only — a snapshot failure must never block a tool call */
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
      // Snapshot BEFORE reporting: reporting is a fire-and-forget network call
      // and must never delay the one thing that actually has to happen ahead
      // of the write.
      if (op === "write" || op === "edit") snapshotBeforeWrite(absPath);
      if (op) report(op, absPath);
    } catch {
      /* never let activity reporting disrupt a tool call */
    }
    // Intentionally return nothing: returning `{ block: true }` would block the
    // tool. Mesa only observes and defensively snapshots; it never gates or
    // alters Pi's tools.
  });
}
