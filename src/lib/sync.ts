import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";

/**
 * Peer-to-peer LAN / Tailscale sync — end-to-end encrypted over TLS.
 *
 * Each device runs an embedded HTTPS server (Rust, `sync.rs`) that serves the
 * vault. The transport is TLS with a per-device self-signed certificate, so
 * vault contents and the sync key are encrypted on the wire. Access is gated by
 * a shared Bearer token (the sync key).
 *
 * The ENTIRE sync engine runs natively (`sync_run` in `sync.rs`): remote
 * manifest over pinned TLS, local manifest (streamed + cached hashing), diff,
 * then bounded-concurrency transfers over one pooled client with per-file
 * verification, atomic writes, and per-file error collection. Vault bytes and
 * hashing never touch the webview — with hundreds of files, webview-side
 * hashing and one-TLS-handshake-per-file transfers are what made large vaults
 * crawl and fail silently. The native client pins the peer's SHA-256
 * certificate fingerprint (trust-on-first-use, then enforced) to detect a
 * man-in-the-middle. Sync is two-way and never destructive: when both sides
 * changed a file, the remote version is saved as a conflict copy rather than
 * overwriting your local edits.
 *
 * While a sync runs, Rust emits `sync://log` and `sync://progress` events;
 * the store collects them for the in-app sync console (see SyncModal), and
 * `syncDiagnostics.ts` turns them into a copyable troubleshooting package.
 *
 * `fnv1a`, `diffManifests`, and `conflictName` below are REFERENCE
 * IMPLEMENTATIONS of the cross-language contract: the Rust engine
 * (`sync_core.rs`) mirrors them byte-for-byte, and both sides pin the same
 * test vectors (src/lib/sync.test.ts ↔ `cargo test`). Change them only in
 * lockstep.
 */

export interface ManifestEntry {
  rel: string;
  size: number;
  hash: string;
}

/** FNV-1a (64-bit). Byte-for-byte identical to the Rust engine's hash. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

export interface ManifestDiff {
  pull: string[]; // present on remote only → create locally
  push: string[]; // present locally only → send to remote
  conflict: string[]; // present both sides, content differs
}

/**
 * Safe two-way diff: unique files flow each direction; files that differ on
 * both sides are conflicts (handled non-destructively by the caller).
 * Reference twin of `diff_manifests` in sync_core.rs.
 */
export function diffManifests(
  local: ManifestEntry[],
  remote: ManifestEntry[]
): ManifestDiff {
  const L = new Map(local.map((e) => [e.rel, e]));
  const R = new Map(remote.map((e) => [e.rel, e]));
  const pull: string[] = [];
  const push: string[] = [];
  const conflict: string[] = [];
  for (const [rel, r] of R) {
    const l = L.get(rel);
    if (!l) pull.push(rel);
    else if (l.hash !== r.hash) conflict.push(rel);
  }
  for (const rel of L.keys()) {
    if (!R.has(rel)) push.push(rel);
  }
  return { pull, push, conflict };
}

/**
 * Filename for a conflict copy, e.g. "Note (conflict from peer 2026-06-23).md".
 * Reference twin of `conflict_name` in sync_core.rs.
 */
export function conflictName(rel: string, peer: string): string {
  const host = peer.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const date = new Date().toISOString().slice(0, 10);
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  const tag = ` (conflict from ${host} ${date})`;
  if (dot > slash) return rel.slice(0, dot) + tag + rel.slice(dot);
  return rel + tag;
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

/** Normalize a fingerprint to bare lowercase hex (drops colons/spaces/case). */
export function normalizeFingerprint(fp?: string | null): string {
  return (fp || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** True when two cert fingerprints refer to the same certificate. */
export function fingerprintsEqual(a?: string | null, b?: string | null): boolean {
  const na = normalizeFingerprint(a);
  return na.length > 0 && na === normalizeFingerprint(b);
}

/**
 * Human-comparable short form of a SHA-256 cert fingerprint, e.g.
 * "A1:B2:C3:D4:E5:F6:07:18". Shows the first `bytes` bytes — enough to compare
 * by eye across two devices without reading all 32.
 */
export function formatFingerprint(fp?: string | null, bytes = 8): string {
  const hex = normalizeFingerprint(fp);
  const pairs = hex.match(/.{2}/g);
  if (!pairs) return "";
  return pairs.slice(0, bytes).join(":").toUpperCase();
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

/** One structured line emitted by the Rust engine during a sync. */
export interface SyncLogEntry {
  /** Epoch milliseconds. */
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

/** Live progress emitted by the Rust engine. */
export interface SyncProgress {
  phase: "manifest" | "scan" | "transfer" | "done";
  done: number;
  total: number;
  /** File currently reported (transfer phase). */
  rel: string;
}

export const SYNC_LOG_EVENT = "sync://log";
export const SYNC_PROGRESS_EVENT = "sync://progress";

/** A single file that could not be scanned or transferred. */
export interface SyncFailure {
  rel: string;
  op: "pull" | "push" | "conflict" | "scan";
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
 * null the first time to trust-on-first-use. Returns the full report,
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
  pin?: string | null
): Promise<SyncReport> {
  const base = normalizePeer(peer, true);
  return await invoke<SyncReport>("sync_run", {
    root,
    base,
    token,
    pin: pin ?? null,
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
