import { nativeCredential } from "./syncSecrets";
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";
import { normalizePeer } from "./syncUi";
export {
  SYNC_LOG_EVENT,
  SYNC_PROGRESS_EVENT,
  SYNC_LOG_LIMIT,
  mergeSyncLog,
  type SyncLogEntry,
  type SyncProgress,
  normalizeFingerprint,
  formatFingerprint,
} from "./syncProtocol";
// Discovery, status and remote-vault probes live in syncUi.ts; these re-exports keep older import paths working.
export { peerFromDiscovery, type DiscoveredSyncPeer } from "./syncUi";

/** Native sync command facade and event types. Hashing, manifests, and file transfers stay in Rust.
 * See docs/sync.md and docs/security.md for authentication and evidence limits. */

// --- server control (Rust commands) --------------------------------------
export async function startSyncServer(
  port: number,
  token: string,
  vault: string,
  bindAddress = "127.0.0.1"
): Promise<void> {
  token = await nativeCredential(token);
  await invoke("sync_start", { port, token, vault, bindAddress });
}
export async function stopSyncServer(): Promise<void> {
  await invoke("sync_stop");
}
// --- sync engine events + report ------------------------------------------

// Report types remain with the engine because they describe a completed run.

/** A single file that could not be scanned or transferred. */
export interface SyncFailure {
  rel: string;
  op: "pull" | "pull update" | "push" | "push update" | "conflict" | "scan" | "baseline" | "journal";
  error: string;
}

/** Full result of one `sync_run` — everything the console + status line show. */
export interface SyncReport {
  /** The peer's TLS certificate fingerprint observed during this sync. */
  fingerprint: string;
  pulled: number;
  pushed: number;
  conflicts: number;
  upToDate: number;
  failed: SyncFailure[];
  bytesPulled: number;
  bytesPushed: number;
  totalLocal: number;
  totalRemote: number;
  durationMs: number;
  cancelled: boolean;
}

export type SyncPhase =
  | "idle"
  | "preparing"
  | "waiting"
  | "transferring"
  | "retrying"
  | "offline"
  | "incomplete"
  | "complete"
  | "cancelled"
  | "disabled"
  | "error";

// --- client orchestration -------------------------------------------------

/** Run native two-way sync. Enforce a supplied fingerprint or record first contact for the caller to retain.
 * Return transfer failures and subscribe to log/progress events for updates. */
export async function syncWithPeer(
  root: string,
  peer: string,
  token: string,
  pin?: string | null,
  retry?: string[] | null,
  peerName?: string | null
): Promise<SyncReport> {
  token = await nativeCredential(token);
  const base = normalizePeer(peer, true);
  return await invoke<SyncReport>("sync_run", {
    root,
    base,
    token,
    pin: pin ?? null,
    retry: retry?.length ? retry : null,
    peerName: peerName ?? null,
  });
}

/** Ask the running sync to stop after the transfers already in flight. */
export async function cancelSync(): Promise<void> {
  if (!IN_TAURI) return;
  try {
    await invoke("sync_cancel");
  } catch {
    /* no sync running */
  }
}

export async function retireSyncPeer(root: string, fingerprint: string): Promise<void> {
  await retireSyncPeers(root, [fingerprint]);
}

export async function retireSyncPeers(root: string, fingerprints: string[]): Promise<void> {
  if (IN_TAURI && fingerprints.length) await invoke("sync_retire_peer", { root, fingerprints });
}
