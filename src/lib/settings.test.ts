import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, normalizeSettings, persistSettings, scrubStoredSyncSecrets } from './settings';
function storage(raw: string | null = null) { const map = new Map<string, string>(); if (raw !== null) map.set(SETTINGS_KEY, raw); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; }
describe('settings upgrade and failure behavior', () => {
  it('retains validated peer retirement across reloads', () => {
    const fingerprint = 'a'.repeat(64);
    const normalized = normalizeSettings({ retiredSyncPeers: [fingerprint, fingerprint, 'invalid', null] });
    expect(normalized.retiredSyncPeers).toEqual([fingerprint]);
    const target = storage(); persistSettings(normalized, target);
    expect(loadSettings(target).settings.retiredSyncPeers).toEqual([fingerprint]);
  });
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
  it('removes obsolete Mesa-side provider credentials while retaining unrelated future fields', () => {
    const source = storage(JSON.stringify({
      ...DEFAULT_SETTINGS,
      syncDeviceName: 'Stable Name',
      agentProvider: 'legacy-provider',
      agentModel: 'legacy-model',
      agentEndpoint: 'https://provider.invalid',
      agentApiKey: 'private-legacy-value',
      future: { enabled: true },
    }));
    const loaded = loadSettings(source);
    expect(loaded.issue).toBe('');
    const saved = JSON.parse(source.getItem(SETTINGS_KEY)!);
    expect(saved).not.toHaveProperty('agentProvider');
    expect(saved).not.toHaveProperty('agentModel');
    expect(saved).not.toHaveProperty('agentEndpoint');
    expect(saved).not.toHaveProperty('agentApiKey');
    expect(saved.future).toEqual({ enabled: true });
  });
  it('ignores unsupported peer fields and keeps trusted fingerprints', () => { expect(normalizeSettings({ syncPeers: ['peer:8787'] }).peers).toEqual([]); const peer = { id: 'one', name: 'One', address: 'peer', favorite: true, fingerprint: 'a'.repeat(64) }; expect(normalizeSettings({ peers: [peer] }).peers[0].fingerprint).toBe(peer.fingerprint); });
  it('never writes new sync keys to browser storage and retains old keys until migration succeeds', () => {
    const old = 'a'.repeat(64), fresh = 'b'.repeat(64);
    const source = storage(JSON.stringify({ syncToken: old, peers: [{ id: 'one', name: 'One', address: 'peer', token: old }] }));
    const settings = { ...loadSettings(source).settings, syncToken: fresh, peers: [{ id: 'one', name: 'One', address: 'peer', favorite: false, token: fresh }] };
    expect(persistSettings(settings, source)).toBe('');
    expect(JSON.parse(source.getItem(SETTINGS_KEY)!).syncToken).toBe(old);
    expect(JSON.parse(source.getItem(SETTINGS_KEY)!).peers[0].token).toBe(old);
    scrubStoredSyncSecrets(source);
    expect(source.getItem(SETTINGS_KEY)).not.toContain(old);
    expect(source.getItem(SETTINGS_KEY)).not.toContain(fresh);
    expect(persistSettings(settings, source)).toBe('');
    expect(source.getItem(SETTINGS_KEY)).not.toContain(fresh);
  });
});

it('starts offline and never resumes network discovery from saved settings', () => {
  expect(DEFAULT_SETTINGS.syncEnabled).toBe(false);
  expect(DEFAULT_SETTINGS.syncDiscovery).toBe(false);
  expect(DEFAULT_SETTINGS.syncBindAddress).toBe('127.0.0.1');
  expect(normalizeSettings({ syncDiscovery: true, syncEnabled: true }).syncDiscovery).toBe(false);
  expect(normalizeSettings({ syncEnabled: true }).syncEnabled).toBe(true);
});
