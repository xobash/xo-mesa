import { nativeCredential } from "./syncSecrets";
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";
import { normalizeFingerprint } from "./syncProtocol";
export { formatFingerprint, type SyncProgress } from "./syncProtocol";

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
  const port = Number(packet.port);
  if (!host || host === "0.0.0.0") return null;
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

export async function startSyncDiscovery(name: string, port: number, listening: boolean): Promise<void> {
  if (!IN_TAURI) return;
  await invoke("sync_discovery_start", { name, port, listening });
}

export async function stopSyncDiscovery(): Promise<void> {
  if (!IN_TAURI) return;
  await invoke("sync_discovery_stop");
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

/** This device's own TLS certificate fingerprint (for out-of-band comparison). */
export async function syncIdentity(): Promise<string | null> {
  if (!IN_TAURI) return null;
  try {
    return await invoke<string>("sync_identity");
  } catch {
    return null;
  }
}

export const IS_WINDOWS = typeof navigator !== "undefined" && /^Win/.test(navigator.platform || "");

/** Quiet time before an empty nearby list suggests a firewall block: three announcement cycles. */
export const DISCOVERY_QUIET_MS = 6_000;

const UNREACHABLE = /couldn't reach that device|timed out reaching that device/i;

/** Literal private or link-local address: the only peers a LAN firewall rule can explain. */
export function isLanAddress(address: string): boolean {
  let host = address.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else if ((host.match(/:/g) ?? []).length === 1) host = host.slice(0, host.indexOf(":"));
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return host.includes(":") && /^(f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):/i.test(host);
}

/**
 * Windows Defender Firewall silently drops inbound sync and discovery on a
 * Public network profile, or after its first-run prompt was dismissed. Offer
 * that guidance only on Windows, and only when a bound discovery socket heard
 * nobody or a LAN peer refused or timed out. Name resolution and internet
 * failures are not firewall evidence.
 */
export function windowsFirewallHint(input: {
  windows: boolean;
  discoveryQuiet: boolean;
  nearbyCount: number;
  peers: readonly { address: string; lastStatus?: string; lastError?: string }[];
}): boolean {
  if (!input.windows) return false;
  return (
    (input.discoveryQuiet && input.nearbyCount === 0) ||
    input.peers.some(
      (peer) =>
        peer.lastStatus === "error" && UNREACHABLE.test(peer.lastError ?? "") && isLanAddress(peer.address),
    )
  );
}

/** Peer base URL: bare addresses get a scheme (HTTPS by default; sync is TLS-only), trailing slashes go. */
export function normalizePeer(peer: string, preferHttps = true): string {
  let p = peer.trim();
  if (!/^https?:\/\//i.test(p)) p = (preferHttps ? "https://" : "http://") + p;
  return p.replace(/\/+$/, "");
}

/** Peer vault summary; also the shape returned by the native `sync_fetch_manifest` command. */
export interface RemoteVaultInfo {
  files: number;
  bytes: number;
  /** The peer's TLS certificate fingerprint (for trust-on-first-use). */
  fingerprint: string;
}

/** Probe peer reachability and key authentication, returning its vault summary and observed certificate fingerprint. */
export async function fetchRemoteVaultInfo(peer: string, token: string, pin?: string | null): Promise<RemoteVaultInfo> {
  token = await nativeCredential(token);
  const base = normalizePeer(peer, true);
  const manifest = await invoke<RemoteVaultInfo>("sync_fetch_manifest", { base, token, pin: pin ?? null });
  return { files: manifest.files, bytes: manifest.bytes, fingerprint: manifest.fingerprint };
}
