import { expect, it } from 'vitest';
import { refreshDiscoveredPeers, DISCOVERY_PEER_LIMIT } from './discoveryPeers';
import type { DiscoveredSyncPeer } from './sync';
it('bounds discovery retention and removes expired devices', () => {
  let peers: Record<string, DiscoveredSyncPeer> = {};
  for (let i = 0; i < 3000; i++) peers = refreshDiscoveredPeers(peers, { id: String(i), seenAt: i } as DiscoveredSyncPeer, i);
  expect(Object.keys(peers)).toHaveLength(DISCOVERY_PEER_LIMIT);
  expect(peers['2999']).toBeDefined(); expect(peers['0']).toBeUndefined();
  expect(refreshDiscoveredPeers(peers, undefined, 3000)).toBe(peers);
  expect(refreshDiscoveredPeers(peers, undefined, 25000)).toEqual({});
});
