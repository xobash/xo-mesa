import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { VaultFile, NoteMeta } from "../types";
import { IN_TAURI, writeNote, createNote, removeVaultEntry } from "./vault";
import { getPiSessionSnapshot } from "./piSessionBridge";
import {
  buildApplyPlan,
  type ApplyPlan,
  type ProposedOp,
} from "./deepResearch";

/**
 * Deep Research — the side-effectful run driver.
 *
 * This module is the ONLY place a Deep Research run touches the outside
 * world: the shared Pi PTY (read + write), the Tauri event bridge that the
 * loopback activity server re-emits the Pi extension's messages on, and the
 * verified vault writes that apply a reviewed change set. Everything else —
 * context selection, validation, change-set building, apply planning — is
 * pure logic in `deepResearch.ts`.
 *
 * Hard guarantees enforced here:
 * - It reuses the ONE shared Pi session (via `getPiSessionSnapshot`); it
 *   never spawns a Pi process. If the session is not running yet, it asks the
 *   store to open a Pi surface (which starts the shared session through the
 *   normal path) and waits for it.
 * - Every create/update goes through `persistVerifiedBytes` (via `writeNote` /
 *   `createNote`) — never a blind overwrite.
 * - Applying a change set is all-or-nothing: it follows the pure
 *   `buildApplyPlan`, and on any failure restores already-changed files and
 *   removes newly created ones before reporting the exact failed operation.
 */

// ---------------------------------------------------------------------------
// Pi session access
// ---------------------------------------------------------------------------

/**
 * Return the live shared Pi session id, or null if Pi is not running in THIS
 * window's realm. Never starts a process itself.
 */
export function currentPiSessionId(): string | null {
  return getPiSessionSnapshot().sessionId;
}

/** Write raw input to the shared Pi session's PTY. */
export async function sendToPi(sessionId: string, input: string): Promise<void> {
  if (!IN_TAURI) throw new Error("Pi is unavailable outside the desktop app.");
  await invoke("terminal_write", { sessionId, input });
}

/**
 * Interrupt the shared Pi session (Ctrl+C). Used for cooperative cancel; it
 * does NOT kill the process, so the user's session survives.
 */
export async function interruptPi(sessionId: string): Promise<void> {
  if (!IN_TAURI) return;
  await invoke("terminal_write", { sessionId, input: "" }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Event bridge (the loopback server re-emits the extension's POSTs)
// ---------------------------------------------------------------------------

export interface DeepResearchEvent {
  kind: "progress" | "finish";
  runId: string;
  phase?: string;
  message?: string;
  /** The structured activity kind (plan | subquestion | source | note | synthesize | status). */
  activityKind?: string;
  round?: number;
  subQuestion?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  draftMarkdown?: string;
  result?: unknown;
}

/**
 * Subscribe to `mesa://deep-research` events. The listener registration is
 * async, so this returns a promise of an unsubscribe function. In the browser
 * demo (no Tauri) it resolves to a no-op.
 */
export async function listenDeepResearch(
  handler: (evt: DeepResearchEvent) => void
): Promise<() => void> {
  if (!IN_TAURI) return () => undefined;
  const unlisten = await listen<string>("mesa://deep-research", (ev) => {
    try {
      const raw = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
      if (raw && typeof raw === "object" && typeof raw.kind === "string") {
        handler(raw as DeepResearchEvent);
      }
    } catch {
      /* ignore malformed deep-research payloads */
    }
  });
  return () => {
    try {
      void (unlisten() as unknown as Promise<void> | void);
    } catch {
      /* ignore */
    }
  };
}

// ---------------------------------------------------------------------------
// Transactional apply (verified writes + all-or-nothing rollback)
// ---------------------------------------------------------------------------

export interface ApplyOutcome {
  ok: boolean;
  appliedRelPaths: string[];
  failedRelPath?: string;
  error?: string;
  /** True when a rollback was performed after a partial failure. */
  rolledBack?: boolean;
}

/**
 * Apply a reviewed change set through verified atomic writes, all-or-nothing.
 *
 * Steps run in the pure plan's order (creates before updates). Each update's
 * `expectedBytes` was already version-checked against the vault when the plan
 * was built; if ANY step fails mid-apply, the rollback plan runs in reverse —
 * restoring every updated file's original bytes and removing every created
 * file — so the vault is left in its original state and no partial generated
 * artifacts survive. Each individual write/remove itself goes through
 * `persistVerifiedBytes` / the vault helpers.
 */
export async function applyChangeSet(input: {
  root: string;
  plan: Extract<ApplyPlan, { ok: true }>;
}): Promise<ApplyOutcome> {
  const { root, plan } = input;
  const applied: string[] = [];
  // Track which rollback steps are still needed, in reverse-apply order.
  const doneCreates: string[] = [];
  const doneUpdates: { relPath: string; originalContent: string }[] = [];

  const rollback = async (): Promise<string[]> => {
    const failures: string[] = [];
    // Restore updated files' original bytes (verified writes), newest first.
    for (let i = doneUpdates.length - 1; i >= 0; i--) {
      const u = doneUpdates[i];
      const file = findFile(root, u.relPath);
      await writeNote(file, u.originalContent).catch((e) => {
        failures.push(`restore ${u.relPath}: ${String(e)}`);
      });
    }
    // Remove created files, newest first.
    for (let i = doneCreates.length - 1; i >= 0; i--) {
      await removeVaultEntry(root, doneCreates[i]).catch((e) => {
        failures.push(`remove ${doneCreates[i]}: ${String(e)}`);
      });
    }
    return failures;
  };

  for (const step of plan.steps) {
    try {
      if (step.kind === "create") {
        // `expectedMissing=true` is checked from disk inside the verified-write
        // transaction, so a file created after review is never overwritten.
        await createNote(root, step.relPath, step.content, true);
        doneCreates.push(step.relPath);
      } else {
        const file = findFile(root, step.relPath);
        // Re-check exact on-disk bytes inside the verified-write transaction;
        // the store cache is only the proposal snapshot, never apply authority.
        await writeNote(file, step.content, step.expectedBytes ?? step.originalContent ?? "");
        doneUpdates.push({ relPath: step.relPath, originalContent: step.originalContent ?? "" });
      }
      applied.push(step.relPath);
    } catch (e) {
      const rollbackFailures = await rollback();
      const restored = rollbackFailures.length === 0;
      return {
        ok: false,
        appliedRelPaths: [],
        failedRelPath: step.relPath,
        error: restored
          ? `Apply failed on "${step.relPath}": ${String(e)}. The vault was restored to its original state.`
          : `Apply failed on "${step.relPath}": ${String(e)}. Rollback also failed: ${rollbackFailures.join("; ")}`,
        rolledBack: restored,
      };
    }
  }
  return { ok: true, appliedRelPaths: applied };
}

// A minimal VaultFile lookup for the driver's writes. The store passes the
// authoritative file map via `resolveApplyPlan`; this helper only rebuilds a
// VaultFile for a known in-vault relPath when the caller already validated it.
function findFile(root: string, relPath: string): VaultFile {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const name = relPath.split("/").pop() ?? relPath;
  const dot = name.lastIndexOf(".");
  return {
    path: `${root.replace(/[\\/]+$/, "")}${sep}${relPath.split("/").join(sep)}`,
    relPath,
    name: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    isMarkdown: /\.(md|markdown)$/i.test(name),
  };
}

/**
 * Version-check a proposed change set against the CURRENT vault state and
 * produce the executable apply plan, or a failure describing the exact
 * problem (unsafe path, stale file, missing target). Thin wrapper over the
 * pure planner so the store has one call to make.
 */
export function resolveApplyPlan(input: {
  ops: ProposedOp[];
  existingContent: Record<string, string>;
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
}): ApplyPlan {
  return buildApplyPlan(input);
}
