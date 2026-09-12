import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";
import { normalizeFingerprint } from "./syncProtocol";
export { formatFingerprint, type SyncProgress } from "./syncProtocol";

export interface DiscoveryPacket { mesaDiscovery: boolean; version: string; name: string; host: string; port: number; protocol: "http" | "https" | string; listening: boolean; fingerprint: string; }
export interface DiscoveredSyncPeer { id: string; name: string; address: string; host: string; port: number; listening: boolean; fingerprint: string; seenAt: number; }
export function peerFromDiscovery(packet: DiscoveryPacket, now = Date.now()): DiscoveredSyncPeer | null {
  if (!packet.mesaDiscovery || !packet.host || !packet.port) return null;
  const host = packet.host.trim(), port = Number(packet.port);
  if (!host || host === "0.0.0.0" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const fingerprint = normalizeFingerprint(packet.fingerprint);
  return { id: fingerprint || `${host}:${port}`, name: packet.name?.trim() || "Mesa device", address: `${host}:${port}`, host, port, listening: !!packet.listening, fingerprint, seenAt: now };
}
export async function startSyncDiscovery(name: string, port: number, listening: boolean): Promise<void> { if (IN_TAURI) await invoke("sync_discovery_start", { name, port, listening }); }
export async function stopSyncDiscovery(): Promise<void> { if (IN_TAURI) await invoke("sync_discovery_stop"); }
export async function syncServerRunning(): Promise<boolean> { if (!IN_TAURI) return false; try { return await invoke<boolean>("sync_status"); } catch { return false; } }
export async function localSyncAddr(): Promise<string | null> { if (!IN_TAURI) return null; try { return await invoke<string>("sync_local_addr"); } catch { return null; } }
export async function syncIdentity(): Promise<string | null> { if (!IN_TAURI) return null; try { return await invoke<string>("sync_identity"); } catch { return null; } }
export interface RemoteVaultInfo { files: number; bytes: number; fingerprint: string; }
export async function fetchRemoteVaultInfo(peer: string, token: string, pin?: string | null): Promise<RemoteVaultInfo> {
  const trimmed = peer.trim(), base = (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).replace(/\/+$/, "");
  const manifest = await invoke<{ fingerprint: string; files: { size: number }[] }>("sync_fetch_manifest", { base, token, pin: pin ?? null });
  return { files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + (file.size || 0), 0), fingerprint: manifest.fingerprint };
}
