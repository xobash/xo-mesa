import { nativeCredential } from "./syncSecrets";
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";
import { normalizeFingerprint } from "./syncProtocol";
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

/** Native sync command facade and event types. Hashing, manifests, and file transfers stay in Rust.
 * See docs/sync.md and docs/security.md for authentication and evidence limits. */

export interface ManifestEntry {
  rel: string;
  size: number;
  hash: string;
}

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
export async function syncServerRunning(): Promise<boolean> {
  if (!IN_TAURI) return false;
  try {
    return await invoke<boolean>("sync_status");
  } catch {
    return false;
  }
}
/** This device's LAN IP (best effort), used to render its pairing code. */
export async function localSyncAddr(): Promise<string | null> {
  if (!IN_TAURI) return null;
  try {
    return await invoke<string>("sync_local_addr");
  } catch {
    return null;
  }
}

// --- client orchestration -------------------------------------------------
export function normalizePeer(peer: string, preferHttps = true): string {
  let p = peer.trim();
  if (!/^https?:\/\//i.test(p)) p = (preferHttps ? "https://" : "http://") + p;
  return p.replace(/\/+$/, "");
}

/** This device's own TLS certificate fingerprint (for out-of-band comparison). */
export async function syncIdentity(): Promise<string | null> {
  if (!IN_TAURI) return null;
  try {
    return await invoke<string>("sync_identity");
  } catch {
    return null;
  }
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

export interface DiscoveryPacket {
  mesaDiscovery: boolean;
  version: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https" | string;
  listening: boolean;
  fingerprint: string;
}

export interface DiscoveredSyncPeer {
  id: string;
  name: string;
  address: string;
  host: string;
  port: number;
  listening: boolean;
  /** The peer's TLS certificate fingerprint, advertised for pinning. */
  fingerprint: string;
  seenAt: number;
}

export function peerFromDiscovery(packet: DiscoveryPacket, now = Date.now()): DiscoveredSyncPeer | null {
  if (!packet.mesaDiscovery || !packet.host || !packet.port) return null;
  const host = packet.host.trim();
  if (!host || host === "0.0.0.0") return null;
  const port = Number(packet.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const fingerprint = normalizeFingerprint(packet.fingerprint);
  return {
    id: fingerprint || `${host}:${port}`,
    name: packet.name?.trim() || "Mesa device",
    address: `${host}:${port}`,
    host,
    port,
    listening: !!packet.listening,
    fingerprint,
    seenAt: now,
  };
}

export async function startSyncDiscovery(
  name: string,
  port: number,
  listening: boolean
): Promise<void> {
  if (!IN_TAURI) return;
  await invoke("sync_discovery_start", { name, port, listening });
}

export async function stopSyncDiscovery(): Promise<void> {
  if (!IN_TAURI) return;
  await invoke("sync_discovery_stop");
}

export interface RemoteVaultInfo {
  files: number;
  bytes: number;
  /** The peer's TLS certificate fingerprint (for trust-on-first-use). */
  fingerprint: string;
}

/** Shape returned by the native `sync_fetch_manifest` command. */
interface RemoteManifest {
  fingerprint: string;
  files: ManifestEntry[];
}

/** Probe peer reachability and key authentication, returning its vault summary and observed certificate fingerprint. */
export async function fetchRemoteVaultInfo(
  peer: string,
  token: string,
  pin?: string | null
): Promise<RemoteVaultInfo> {
  token = await nativeCredential(token);
  const base = normalizePeer(peer, true);
  const manifest = await invoke<RemoteManifest>("sync_fetch_manifest", {
    base,
    token,
    pin: pin ?? null,
  });
  return {
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, e) => sum + (e.size || 0), 0),
    fingerprint: manifest.fingerprint,
  };
}

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
