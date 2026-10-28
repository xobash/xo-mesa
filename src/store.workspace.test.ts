// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(async () => ({ ok: true, text: '' })), forget: vi.fn(), resolve: vi.fn() }));
vi.mock('./lib/vault', async original => ({ ...await original<object>(), createNote: io.create, readNoteResult: io.read }));
vi.mock('./lib/persistedUi', async original => ({ ...await original<object>(), forgetRecentVaultNative: io.forget, resolveRecentVault: io.resolve }));
import { useAppStore } from './store';
import type { VaultFile } from './types';
const initial = useAppStore.getState();
const store = () => useAppStore.getState();
beforeEach(() => { vi.clearAllMocks(); useAppStore.setState(initial); });
afterEach(() => useAppStore.setState(initial));

describe('workspace UI state', () => {
  it('keeps the Mesa and Pi overlays mutually exclusive', () => {
    store().setPiOverlayOpen(true);
    store().setOverlayOpen(true);
    expect(store()).toMatchObject({ overlayOpen: true, piOverlayOpen: false });
    store().setPiOverlayOpen(true);
    expect(store()).toMatchObject({ overlayOpen: false, piOverlayOpen: true });
    store().toggleOverlay();
    expect(store()).toMatchObject({ overlayOpen: true, piOverlayOpen: false });
    store().toggleOverlay();
    expect(store().overlayOpen).toBe(false);
    store().setOverlayOpen(false);
    expect(store().piOverlayOpen).toBe(false);
  });

  it('tracks hover, drag, focus, folders and panel visibility', () => {
    store().showHoverPreview({ kind: 'note', path: 'A.md' } as never, 3, 4);
    expect(store().hoverPreview).toMatchObject({ x: 3, y: 4 });
    store().hideHoverPreview(); store().hideHoverPreview();
    expect(store().hoverPreview).toBeNull();
    store().setDragView('graph' as never); store().setDraggingFile('A.md'); store().setDragGhost({ label: 'A' } as never);
    store().setKeyboardFocus({ region: 'right', rightIndex: 1 } as never);
    expect(store()).toMatchObject({ dragView: 'graph', draggingFile: 'A.md', dragGhost: { label: 'A' }, keyboardFocus: { region: 'right', rightIndex: 1 } });
    store().toggleFolder('docs'); expect(store().collapsedFolders.docs).toBe(true);
    store().toggleFolder('docs'); expect(store().collapsedFolders.docs).toBe(false);
    store().setCollapsedFolders({ a: true }); expect(store().collapsedFolders).toEqual({ a: true });
    for (const [action, key] of [['setTasksOpen', 'tasksOpen'], ['setHelpOpen', 'helpOpen'], ['setTourOpen', 'tourOpen'], ['setAgentOpen', 'agentOpen'], ['setPalette', 'paletteOpen'], ['setSearch', 'searchOpen'], ['setDiagnosticsOpen', 'diagnosticsOpen'], ['setSyncOpen', 'syncOpen']] as const) {
      (store()[action] as (open: boolean) => void)(true);
      expect(store()[key]).toBe(true);
      (store()[action] as (open: boolean) => void)(false);
      expect(store()[key]).toBe(false);
    }
    const tick = store().revealTick; store().revealActiveFile(); expect(store().revealTick).toBe(tick + 1);
  });

  it('opens search with a seed and routes settings to the right section', () => {
    store().openSearch('tag:#x');
    expect(store()).toMatchObject({ searchOpen: true, searchSeed: 'tag:#x' });
    store().setSearchSeed('y'); expect(store().searchSeed).toBe('y');
    const before = store().revisionHistoryRequest;
    store().openRevisionHistory();
    expect(store()).toMatchObject({ settingsOpen: true, settingsSection: 'history', revisionHistoryRequest: before + 1 });
    store().setSettingsOpen(true);
    expect(store().settingsSection).toBe('settings');
  });

  it('persists the theme, UI style and bookmark toggles', () => {
    store().setTheme('dusk' as never);
    store().setUiStyle('studio' as never);
    expect(store()).toMatchObject({ theme: 'dusk', uiStyle: 'studio' });
    store().toggleBookmark('A.md');
    expect(store().settings.bookmarks).toContain('A.md');
    store().toggleBookmark('A.md');
    expect(store().settings.bookmarks).not.toContain('A.md');
    store().setSetting('syncPort', 'not a port' as never);
    expect(store().settings.syncPort).toBe(initial.settings.syncPort);
  });
});

describe('sync peers', () => {
  it('adds a peer once, learns its fingerprint later and renames it', () => {
    expect(store().addPeer('not an address')).toBeNull();
    const id = store().addPeer('192.0.2.10', 'Laptop')!;
    expect(store().settings.peers).toEqual([expect.objectContaining({ id, name: 'Laptop', favorite: false })]);
    expect(store().addPeer('192.0.2.10', 'Again', 'AA:bb')).toBe(id);
    expect(store().settings.peers[0].fingerprint).toBe('aabb');
    store().updatePeer(id, { name: 'Desk' });
    expect(store().settings.peers[0].name).toBe('Desk');
  });
});

describe('daily note', () => {
  it('creates the dated note in the daily folder and opens an existing one directly', async () => {
    const file = { relPath: 'Daily/2026-10-18.md', path: '/v/Daily/2026-10-18.md', name: '2026-10-18', ext: 'md', isMarkdown: true } as unknown as VaultFile;
    io.create.mockResolvedValue(file);
    useAppStore.setState({ vaultPath: '/v', settings: { ...initial.settings, dailyFolder: '/Daily/' } });
    await store().openDailyNote('2026-10-18');
    expect(io.create).toHaveBeenCalledWith('/v', 'Daily/2026-10-18.md', '# 2026-10-18\n\n');
    io.create.mockClear();
    useAppStore.setState({ files: [file] });
    await store().openDailyNote('2026-10-18');
    expect(io.create).not.toHaveBeenCalled();
  });

  it('does nothing without an open vault', async () => {
    await store().openDailyNote('2026-10-18');
    await store().addCalendarEvent('2026-10-18', 'Talk');
    expect(io.create).not.toHaveBeenCalled();
  });
});

describe('recent vaults', () => {
  it('clears and removes recent vault entries, and reports native failures', async () => {
    useAppStore.setState({ recentVaults: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] as never, currentRecentVaultId: 'b' });
    io.forget.mockResolvedValueOnce({ entries: [{ id: 'b', label: 'B' }] });
    await store().removeRecentVault('a');
    expect(store()).toMatchObject({ recentVaults: [{ id: 'b' }], currentRecentVaultId: 'b' });
    io.forget.mockRejectedValueOnce(new Error('denied'));
    await store().removeRecentVault('b');
    expect(store().status).toBe('Could not remove the recent vault.');
    io.forget.mockResolvedValueOnce({ entries: [] });
    await store().clearRecentVaults();
    expect(store()).toMatchObject({ recentVaults: [], currentRecentVaultId: null });
    io.forget.mockRejectedValueOnce(new Error('denied'));
    await store().clearRecentVaults();
    expect(store().status).toBe('Could not clear recent vaults.');
  });

  it('asks for the folder again when a recent vault cannot be resolved', async () => {
    io.resolve.mockRejectedValueOnce(new Error('gone'));
    await store().openRecentVault('missing');
    expect(store().status).toBe('Could not open the recent vault. Select its folder again.');
  });
});

describe('calendar events', () => {
  it('creates calendar.json for the first event', async () => {
    const file = { relPath: 'calendar.json', path: '/v/calendar.json', name: 'calendar', ext: 'json', isMarkdown: false } as unknown as VaultFile;
    io.create.mockResolvedValue(file);
    useAppStore.setState({ vaultPath: '/v', files: [], calendarEvents: [] });
    await store().addCalendarEvent('2026-10-18', '  Talk  ');
    expect(io.create).toHaveBeenCalledWith('/v', 'calendar.json', expect.stringContaining('Talk'));
    expect(store().calendarEvents).toEqual([{ date: '2026-10-18', title: 'Talk' }]);
    expect(store().files).toEqual([file]);
    await store().addCalendarEvent('2026-10-18', '   ');
    expect(io.create).toHaveBeenCalledOnce();
    await store().removeCalendarEvent('2026-10-19', 'none');
  });
});

describe('calendar edits from current text', () => {
  const calendar = { relPath: 'calendar.json', path: '/v/calendar.json', name: 'calendar', ext: 'json', isMarkdown: false } as unknown as VaultFile;
  const typed = JSON.stringify([{ date: '2026-10-20', title: 'Typed in editor' }]);
  it('keeps events typed into calendar.json when adding and removing', async () => {
    useAppStore.setState({ vaultPath: '/v', files: [calendar], fileFor: (rel) => rel === 'calendar.json' ? calendar : undefined, calendarEvents: [], contentCache: { 'calendar.json': typed } });
    await store().addCalendarEvent('2026-10-21', 'Added');
    expect(store().calendarEvents.map((event) => event.title)).toEqual(['Typed in editor', 'Added']);
    expect(store().contentCache['calendar.json']).toContain('Typed in editor');
    await store().removeCalendarEvent('2026-10-21', 'Added');
    expect(store().calendarEvents.map((event) => event.title)).toEqual(['Typed in editor']);
  });
  it('keeps unknown fields and entries it cannot show when adding and removing', async () => {
    const rich = JSON.stringify([{ date: '2026-10-20', title: 'Kept', color: 'red', id: 7 }, { note: 'not an event' }, 'loose', { date: 'soon', title: 'Bad date' }]);
    useAppStore.setState({ vaultPath: '/v', files: [calendar], fileFor: (rel) => rel === 'calendar.json' ? calendar : undefined, calendarEvents: [], contentCache: { 'calendar.json': rich } });
    await store().addCalendarEvent('2026-10-19', 'Added');
    const added = JSON.parse(store().contentCache['calendar.json'] as string);
    expect(added).toEqual([{ date: '2026-10-19', title: 'Added' }, { date: '2026-10-20', title: 'Kept', color: 'red', id: 7 }, { note: 'not an event' }, 'loose', { date: 'soon', title: 'Bad date' }]);
    await store().removeCalendarEvent('2026-10-19', 'Added');
    expect(JSON.parse(store().contentCache['calendar.json'] as string)).toEqual(JSON.parse(rich));
    expect(store().calendarEvents).toEqual([{ date: '2026-10-20', title: 'Kept' }]);
  });
  it('refuses to replace calendar.json text that is not an event list', async () => {
    useAppStore.setState({ vaultPath: '/v', files: [calendar], fileFor: (rel) => rel === 'calendar.json' ? calendar : undefined, calendarEvents: [], contentCache: { 'calendar.json': '[{"date": "2026-' } });
    await store().addCalendarEvent('2026-10-21', 'Added');
    expect(store().contentCache['calendar.json']).toBe('[{"date": "2026-');
    expect(store().status).toContain('not a valid event list');
  });
});

describe('peer removal', () => {
  it('forgets an unpaired peer and ignores unknown ids', async () => {
    const id = store().addPeer('192.0.2.11', 'Phone')!;
    await store().removePeer('unknown');
    expect(store().settings.peers).toHaveLength(1);
    await store().removePeer(id);
    expect(store().settings.peers).toEqual([]);
  });
});
