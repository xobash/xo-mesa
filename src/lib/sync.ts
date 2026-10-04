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

/**
 * Peer-to-peer LAN / Tailscale sync over TLS.
 *
 * Each device runs an embedded HTTPS server (Rust, `sync.rs`) that serves the
 * vault. The transport is TLS with a per-device self-signed certificate, so
 * vault contents are encrypted on the wire. Access is gated by a bearer
 * credential derived from the shared key and the peer certificate fingerprint;
 * the shared key itself is never sent on first contact.
 *
 * The ENTIRE sync engine runs natively (`sync_run` in `sync.rs`): remote
 * manifest over pinned TLS, local manifest (streamed + cached hashing), diff,
 * then bounded-concurrency transfers over one pooled client with per-file
 * verification, atomic writes, and per-file error collection. Vault bytes and
 * hashing never touch the webview — with hundreds of files, webview-side
 * hashing and one-TLS-handshake-per-file transfers are what made large vaults
 * crawl and fail silently. The native client pins the peer's SHA-256
 * certificate fingerprint (observed without credentials on first contact, then
 * enforced) to detect a man-in-the-middle after pairing. The native engine
 * records a per-peer common version and conditionally replaces one-sided edits.
 * Divergent edits remain conflict copies.
 *
 * While a sync runs, Rust emits `sync://log` and `sync://progress` events;
 * the store collects them for the in-app sync console (see SyncModal), and
 * `syncDiagnostics.ts` turns them into a copyable troubleshooting package.
 *
 */

export interface ManifestEntry {
  rel: string;
  size: number;
  hash: string;
}

// --- server control (Rust commands) --------------------------------------
export async function startSyncServer(
  port: number,
  token: string,
  vault: string
): Promise<void> {
  await invoke("sync_start", { port, token, vault });
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

/**
 * Probe a peer with the given key and return a summary of the vault it's
 * sharing, plus its certificate fingerprint. Used by the "Open shared vault"
 * flow to confirm the address + key are right *before* asking the user to pick
 * a download folder. The native command throws a human-readable error on a bad
 * key, unreachable host, non-Mesa peer, or a certificate that fails a supplied
 * pin.
 */
export async function fetchRemoteVaultInfo(
  peer: string,
  token: string,
  pin?: string | null
): Promise<RemoteVaultInfo> {
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

/**
 * Run a full two-way sync against one peer over pinned TLS. `pin` is the
 * peer's known certificate fingerprint (from a prior sync or discovery); pass
 * null the first time to trust-on-first-use without exposing the shared key. Returns the full report,
 * including the fingerprint that was actually observed (the caller should
 * remember it) and every per-file failure (a failed file never aborts the
 * rest of the sync).
 *
 * Everything — local hashing, diffing, transfers — runs in Rust
 * (`sync_run`): bytes never round-trip through the webview. Subscribe to
 * `SYNC_LOG_EVENT` / `SYNC_PROGRESS_EVENT` for the live console.
 */
export async function syncWithPeer(
  root: string,
  peer: string,
  token: string,
  pin?: string | null,
  retry?: string[] | null,
  peerName?: string | null
): Promise<SyncReport> {
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
