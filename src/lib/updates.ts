/**
 * Update status as `src-tauri/src/updater.rs` reports it, plus the restart
 * admission rule. Pure: the controller (`controllers/updates.ts`) does the IPC.
 * Behavior: `docs/updates.md`.
 */

export type UpdateSupport =
  | { kind: "automatic" }
  | { kind: "notifyOnly"; reason: string }
  | { kind: "off"; reason: string };

export type UpdatePhase =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; downloaded: number; total: number | null; percent: number | null }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export type FailureKind = "download" | "signature" | "install";

export type UpdateStatus = UpdatePhase & {
  /** Native change counter; an older status never replaces a newer one. */
  seq: number;
  currentVersion: string;
  support: UpdateSupport;
  /** Unix milliseconds of the last completed check. */
  checkedAt: number | null;
  /** The one remembered failed attempt (automatic retries wait a day). */
  lastFailure: { version: string; kind: FailureKind } | null;
};

/** Native status event, sent to the main window only. */
export const UPDATE_STATUS_EVENT = "mesa://update-status";
/** The launch check waits this long after the main window mounts, then for
 * an idle moment, so it never competes with vault open or the graph warm-up. */
export const LAUNCH_CHECK_DELAY_MS = 3_000;

export const BROWSER_STATUS: UpdateStatus = {
  state: "idle",
  seq: 0,
  currentVersion: "",
  support: { kind: "off", reason: "Updates apply to the Mesa desktop app." },
  checkedAt: null,
  lastFailure: null,
};

const text = (value: unknown, limit = 200): string => (typeof value === "string" ? value.slice(0, limit) : "");
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const FAILURE_KINDS: readonly FailureKind[] = ["download", "signature", "install"];

function normalizeSupport(value: unknown): UpdateSupport {
  const record = (value ?? {}) as Record<string, unknown>;
  if (record.kind === "automatic") return { kind: "automatic" };
  const reason = text(record.reason);
  return record.kind === "notifyOnly" ? { kind: "notifyOnly", reason } : { kind: "off", reason };
}

function normalizePhase(record: Record<string, unknown>): UpdatePhase {
  const version = text(record.version, 64);
  switch (record.state) {
    case "checking": return { state: "checking" };
    case "upToDate": return { state: "upToDate" };
    case "available": return { state: "available", version };
    case "downloading": {
      const percent = count(record.percent);
      return {
        state: "downloading", version,
        downloaded: count(record.downloaded) ?? 0,
        total: count(record.total),
        percent: percent === null ? null : Math.min(100, Math.floor(percent)),
      };
    }
    case "ready": return { state: "ready", version };
    case "error": return { state: "error", message: text(record.message) || "The update check failed." };
    default: return { state: "idle" };
  }
}

function normalizeFailure(value: unknown): UpdateStatus["lastFailure"] {
  const record = (value ?? {}) as Record<string, unknown>;
  const kind = FAILURE_KINDS.find((candidate) => candidate === record.kind);
  const version = text(record.version, 64);
  return kind && version ? { version, kind } : null;
}

/** Accept a native payload; anything malformed reads as idle, never throws. */
export function normalizeUpdateStatus(value: unknown): UpdateStatus {
  const record = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    ...normalizePhase(record),
    seq: count(record.seq) ?? 0,
    currentVersion: text(record.currentVersion, 64),
    support: normalizeSupport(record.support),
    checkedAt: count(record.checkedAt),
    lastFailure: normalizeFailure(record.lastFailure),
  };
}

/** Statuses can arrive out of order (an IPC reply after a later event). */
export function supersedes(next: UpdateStatus, current: UpdateStatus): boolean {
  return next.seq >= current.seq;
}

/** The one-line status shown in Settings. */
export function updateStatusLine(status: UpdateStatus): string {
  switch (status.state) {
    case "checking": return "Checking for updates…";
    case "upToDate": return "Mesa is up to date.";
    case "available": {
      const parts = [`Mesa ${status.version} is available.`];
      if (status.support.kind === "notifyOnly") parts.push(status.support.reason);
      if (status.lastFailure?.version === status.version) parts.push("The last attempt to install it failed; Mesa retries it automatically once a day.");
      return parts.join(" ");
    }
    // The percent sits beside the progress bar, so this live line does not
    // re-announce on every step.
    case "downloading": return `Downloading Mesa ${status.version}…`;
    case "ready": return `Mesa ${status.version} is ready. It installs when you quit Mesa.`;
    case "error": return status.message;
    default:
      return status.support.kind === "off" ? status.support.reason : "Not checked yet.";
  }
}

/** "Checked just now", "Checked 2 min ago", "Checked 3 h ago", "Checked 2 days ago". */
export function checkedAgo(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return "";
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Checked ${days} day${days === 1 ? "" : "s"} ago`;
}

/** Check now is offered unless updates are off or a check, download or ready update is in progress. */
export function canCheckNow(status: UpdateStatus): boolean {
  return status.support.kind !== "off" && !["checking", "downloading", "ready"].includes(status.state);
}

/** "Download and install" for a found version this install can update itself to. */
export function canDownload(status: UpdateStatus): boolean {
  return status.state === "available" && status.support.kind === "automatic";
}

export interface RestartDeps {
  /** Verified save flush of every dirty text and PDF edit (rejects on failure). */
  flush(): Promise<void>;
  /** True while any edit is still unsaved after the flush. */
  pending(): boolean;
  /** Native install and relaunch; refuses while Pi is running. */
  restart(): Promise<void>;
}

/**
 * Restart only after every edit is saved: flush first, refuse if anything is
 * still pending, then ask native code (which also refuses while Pi runs).
 * Returns "" on success or a short plain reason.
 */
export async function restartToUpdate(deps: RestartDeps): Promise<string> {
  try {
    await deps.flush();
  } catch (reason) {
    return `Restart stopped: ${reason instanceof Error ? reason.message : String(reason)}`;
  }
  if (deps.pending()) return "Restart stopped: some changes are not saved yet.";
  try {
    await deps.restart();
    return "";
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
