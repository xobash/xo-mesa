import type { DiscoveredSyncPeer } from './sync';
export const DISCOVERY_PEER_LIMIT = 128;
export const DISCOVERY_TTL_MS = 20_000;
export function refreshDiscoveredPeers(current: Record<string, DiscoveredSyncPeer>, incoming?: DiscoveredSyncPeer, now = Date.now()): Record<string, DiscoveredSyncPeer> {
  const merged = incoming ? { ...current, [incoming.id]: incoming } : current;
  const entries = Object.entries(merged).filter(([, peer]) => now - peer.seenAt < DISCOVERY_TTL_MS).sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, DISCOVERY_PEER_LIMIT);
  if (!incoming && entries.length === Object.keys(current).length) return current;
  return Object.fromEntries(entries);
}
