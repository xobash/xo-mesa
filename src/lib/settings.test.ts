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
  it('loads an overflowing auto-sync interval as a finite timer-safe value', () => {
    expect(loadSettings(storage(JSON.stringify({ syncAutoMinutes: 1e300 }))).settings.syncAutoMinutes).toBe(35_791);
    expect(normalizeSettings({ syncAutoMinutes: 43_200 }).syncAutoMinutes).toBe(35_791);
    expect(normalizeSettings({ syncAutoMinutes: Infinity }).syncAutoMinutes).toBe(0);
    expect(normalizeSettings({ syncAutoMinutes: -1 }).syncAutoMinutes).toBe(0);
  });
  it('preserves every valid current setting', () => { expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS); });
  it('turns automatic updates on by default and keeps a saved opt-out', () => {
    expect(DEFAULT_SETTINGS.autoUpdate).toBe(true);
    expect(normalizeSettings({}).autoUpdate).toBe(true);
    expect(normalizeSettings({ autoUpdate: 'no' }).autoUpdate).toBe(true);
    const target = storage(); persistSettings({ ...DEFAULT_SETTINGS, autoUpdate: false }, target);
    expect(loadSettings(target).settings.autoUpdate).toBe(false);
  });
  it('starts the graph at Obsidian defaults and resets graph settings saved in older units once', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      graphShowTags: false, graphShowAttachments: false, graphShowAllFiles: false, graphExistingFilesOnly: false, graphShowOrphans: true,
      graphArrows: false, graphTextFade: 0, graphNodeSize: 1, graphLinkThickness: 1,
      graphRepelForce: 10, graphLinkForce: 1, graphLinkDistance: 250, graphLivingMotion: false,
    });
    expect(DEFAULT_SETTINGS.graphCenterForce).toBeCloseTo(0.518713248970312, 12);
    // Saved before the unit change: every graph value restarts at the default; other settings stay.
    const old = normalizeSettings({ hoverDelayMs: 900, graphShowAttachments: true, graphExistingFilesOnly: true, graphTextFadeThreshold: 0.42, graphCenterForce: 0.5, graphRepelForce: 18, graphNodeSize: 2 });
    expect(old.hoverDelayMs).toBe(900);
    expect(Object.entries(old).filter(([key]) => key.startsWith('graph'))).toEqual(Object.entries(DEFAULT_SETTINGS).filter(([key]) => key.startsWith('graph')));
    // Saved in the current units: values survive a reload, limited to each slider's range.
    const current = normalizeSettings({ ...DEFAULT_SETTINGS, graphShowAttachments: true, graphShowAllFiles: true, graphRepelForce: 18, graphNodeSize: 99, graphTextFade: -7, graphLinkDistance: 5, graphLivingMotion: true });
    expect(current).toMatchObject({ graphShowAttachments: true, graphShowAllFiles: true, graphRepelForce: 18, graphNodeSize: 5, graphTextFade: -3, graphLinkDistance: 30, graphLivingMotion: true });
    expect(normalizeSettings(current)).toEqual(current);
  });
  it('loads a saved multi-pane layout as a split view', () => {
    const settings = normalizeSettings({ centerView: 'doc', rightStack: ['doc', 'agent', 'preview', 'graph'] });
    expect(settings.rightStack).toEqual(['agent']);
  });
  it('keeps the document pane when the second document pane was the only one', () => {
    expect(normalizeSettings({ centerView: 'agent', rightStack: ['doc2'] })).toMatchObject({ centerView: 'agent', rightStack: ['doc'] });
    expect(normalizeSettings({ centerView: 'doc2', rightStack: ['graph'] })).toMatchObject({ centerView: 'doc', rightStack: ['graph'] });
    expect(normalizeSettings({ centerView: 'doc', rightStack: ['doc2'] })).toMatchObject({ centerView: 'doc', rightStack: [] });
  });
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
  it('a second window saving one setting never reverts a setting the first window changed', () => {
    const source = storage(JSON.stringify({ ...DEFAULT_SETTINGS, syncDeviceName: 'Stable Name' }));
    const main = loadSettings(source).settings, graphWindow = loadSettings(source).settings;
    expect(persistSettings({ ...main, sidebarOpen: !main.sidebarOpen }, source, main)).toBe('');
    // The graph window still holds the old sidebarOpen; it changes only node size.
    expect(persistSettings({ ...graphWindow, graphNodeSize: 2 }, source, graphWindow)).toBe('');
    const saved = loadSettings(source).settings;
    expect(saved.sidebarOpen).toBe(!main.sidebarOpen);
    expect(saved.graphNodeSize).toBe(2);
  });
  it('writes every setting when the stored value predates the graph settings version', () => {
    const source = storage(JSON.stringify({ ...DEFAULT_SETTINGS, syncDeviceName: 'Stable Name', graphSettingsVersion: 1, graphNodeSize: 3 }));
    const loaded = loadSettings(source).settings;
    expect(persistSettings({ ...loaded, sidebarOpen: !loaded.sidebarOpen }, source, loaded)).toBe('');
    expect(JSON.parse(source.getItem(SETTINGS_KEY)!)).toMatchObject({ graphSettingsVersion: DEFAULT_SETTINGS.graphSettingsVersion, graphNodeSize: loaded.graphNodeSize });
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

describe('hotkey settings', () => {
  it('keeps only valid, unreserved, unique hotkeys and never shares the default object', () => {
    const normalized = normalizeSettings({ hotkeys: { theme: 'cmd+shift+t', graph: 'Mod+Shift+T', today: 'Mod+P', 'x y': 'Mod+J' } });
    expect(normalized.hotkeys).toEqual({ theme: 'Mod+Shift+T' });
    expect(normalizeSettings({ hotkeys: 'Mod+K' }).hotkeys).toEqual({});
    expect(normalizeSettings(null).hotkeys).not.toBe(DEFAULT_SETTINGS.hotkeys);
    const target = storage(); persistSettings(normalized, target);
    expect(loadSettings(target).settings.hotkeys).toEqual({ theme: 'Mod+Shift+T' });
  });
});
