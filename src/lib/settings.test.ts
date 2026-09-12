import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, normalizeSettings, persistSettings } from './settings';
function storage(raw: string | null = null) { const map = new Map<string, string>(); if (raw !== null) map.set(SETTINGS_KEY, raw); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; }
describe('settings upgrade and failure behavior', () => {
  it('preserves every valid current setting', () => { expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS); });
  it('repairs malformed containers and fields without throwing at startup', () => {
    for (const value of [null, [], 'text', 4, { peers: [null, {}, { id: 2 }], bookmarks: null, rightStack: false, syncDeviceName: 99, sortMode: 'invalid', syncPort: -1 }]) {
      const settings = normalizeSettings(value); expect(Array.isArray(settings.peers)).toBe(true); expect(Array.isArray(settings.bookmarks)).toBe(true); expect(settings.syncPort).toBe(8787); expect(settings.sortMode).toBe('name');
    }
  });
  it('leaves unreadable settings intact until an explicit repair and preserves their raw value', () => {
    const source = storage('{broken'); const loaded = loadSettings(source); expect(loaded.issue).toContain('preserved'); expect(source.getItem(SETTINGS_KEY)).toBe('{broken');
    expect(persistSettings(loaded.settings, source)).toBe(''); expect(source.getItem(`${SETTINGS_KEY}:recovery`)).toBe('{broken');
  });
  it('never replaces unreadable data if its recovery copy cannot be saved', () => {
    const source = storage('{broken'); const failing = { ...source, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(persistSettings(DEFAULT_SETTINGS, failing)).toContain('could not be saved'); expect(source.getItem(SETTINGS_KEY)).toBe('{broken');
  });
  it('retains future-version fields across an ordinary edit and repeated reloads', () => {
    const source = storage(JSON.stringify({ ...DEFAULT_SETTINGS, syncDeviceName: 'Stable Name', future: { enabled: true } }));
    for (let i = 0; i < 25; i++) { const loaded = loadSettings(source); expect(loaded.settings.syncDeviceName).toBe('Stable Name'); expect(persistSettings({ ...loaded.settings, sidebarOpen: i % 2 === 0 }, source)).toBe(''); }
    expect(JSON.parse(source.getItem(SETTINGS_KEY)!).future).toEqual({ enabled: true });
  });
  it('migrates legacy peer addresses and keeps trusted fingerprints', () => { expect(normalizeSettings({ syncPeers: ['peer:8787'] }).peers[0].address).toBe('peer:8787'); const peer = { id: 'one', name: 'One', address: 'peer', favorite: true, fingerprint: 'a'.repeat(64) }; expect(normalizeSettings({ peers: [peer] }).peers[0].fingerprint).toBe(peer.fingerprint); });
});
