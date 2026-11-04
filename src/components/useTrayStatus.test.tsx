// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emitTo: vi.fn(),
  subscribers: new Set<() => void>(),
  state: {} as Record<string, unknown>,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: io.listen, emitTo: io.emitTo }));
vi.mock('../store', () => ({
  getStore: () => io.state,
  useAppStore: { subscribe: (fn: () => void) => { io.subscribers.add(fn); return () => io.subscribers.delete(fn); } },
}));
import { useTrayStatus } from './useTrayStatus';

type Action = { payload: { action: string; rel?: string; id?: string; query?: string } };
let action: ((event: Action) => void) | null = null;
let popover: ((event: { payload: { query?: string } }) => void) | null = null;
const unlisten = vi.fn();
function Probe({ enabled }: { enabled: boolean }) { useTrayStatus(enabled); return null; }
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
async function render(enabled: boolean) { await act(async () => { root.render(<Probe enabled={enabled} />); }); }
function change(patch: Record<string, unknown>) { io.state = { ...io.state, ...patch }; io.subscribers.forEach((fn) => fn()); }
const sent = () => io.invoke.mock.calls.map(([, args]) => (args as { snapshot: { vault: string | null; sync: string } }).snapshot);

beforeEach(() => {
  vi.useFakeTimers();
  io.invoke.mockResolvedValue(undefined);
  io.emitTo.mockResolvedValue(undefined);
  io.listen.mockImplementation(async (name: string, handler: unknown) => {
    if (name === 'mesa://tray-action') action = handler as typeof action; else popover = handler as typeof popover;
    return unlisten;
  });
  io.state = {
    vaultPath: '/vault', vaultName: 'Synthetic', textSaveState: { pending: 0, saving: 0, failed: 0 },
    notes: {}, contentCache: {}, settings: { ...DEFAULT_SETTINGS }, deepResearch: null, syncBusy: false,
    openSearch: vi.fn(), setTasksOpen: vi.fn(), setSettingsOpen: vi.fn(), selectFile: vi.fn(async () => {}),
    files: [], activePath: null, notesIndexPending: false, recentVaults: [], currentRecentVaultId: null, graphFull: false,
    fileFor: (rel: string) => (io.state.files as { relPath: string }[]).find((f) => f.relPath === rel),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.useRealTimers(); vi.clearAllMocks(); io.subscribers.clear(); action = null; popover = null;
});

it('does nothing outside the main window', async () => {
  await render(false);
  change({ vaultName: 'Other' });
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(io.invoke).not.toHaveBeenCalled(); expect(io.listen).not.toHaveBeenCalled();
  expect(io.subscribers.size).toBe(0);
});

it('sends at mount, then coalesces store churn into one update per second', async () => {
  await render(true);
  expect(sent()).toHaveLength(1);
  expect(io.invoke).toHaveBeenCalledWith('tray_update', expect.anything());
  for (let i = 0; i < 20; i++) change({ vaultName: `Vault ${i}` });
  await act(async () => { vi.advanceTimersByTime(999); });
  expect(sent()).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(sent()).toHaveLength(2);
  expect(sent()[1].vault).toBe('Vault 19');
  // An unchanged snapshot is not resent.
  change({ notes: {} });
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(sent()).toHaveLength(2);
});

it('resends after a failed native update', async () => {
  io.invoke.mockRejectedValueOnce(new Error('tray unavailable'));
  await render(true);
  await act(async () => { await Promise.resolve(); });
  change({ notes: {} });
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(sent()).toHaveLength(2);
});

it('routes tray actions to the store and stops on unmount', async () => {
  io.state = { ...io.state, files: [{ relPath: 'Tasks.md' }] };
  await render(true);
  await act(async () => { await Promise.resolve(); });
  const st = io.state as Record<string, ReturnType<typeof vi.fn>>;
  action!({ payload: { action: 'search' } });
  action!({ payload: { action: 'tasks' } });
  action!({ payload: { action: 'settings' } });
  action!({ payload: { action: 'task', rel: 'Tasks.md' } });
  action!({ payload: { action: 'task' } });
  expect(st.openSearch).toHaveBeenCalledOnce();
  expect(st.setTasksOpen).toHaveBeenCalledWith(true);
  expect(st.setSettingsOpen).toHaveBeenCalledWith(true);
  expect(st.selectFile).toHaveBeenCalledOnce();
  change({ vaultName: 'Later' });
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(sent()).toHaveLength(1);
  expect(unlisten).toHaveBeenCalledTimes(2);
  expect(io.subscribers.size).toBe(0);
});

const file = (relPath: string) => ({ relPath, path: `/vault/${relPath}`, name: relPath.replace(/^.*\//, '').replace(/\.md$/, ''), ext: 'md', isMarkdown: true });

it('answers popover requests with recents, vaults, search results and a mini graph', async () => {
  io.state = {
    ...io.state,
    files: [file('Projects/Alpha.md'), file('Beta.md')],
    notes: {
      'Projects/Alpha.md': { relPath: 'Projects/Alpha.md', title: 'Alpha', rawLinks: ['Beta'], tags: [], aliases: [] },
      'Beta.md': { relPath: 'Beta.md', title: 'Beta', rawLinks: [], tags: [], aliases: [] },
    },
    recentVaults: [{ id: 'aa', label: 'Synthetic' }, { id: 'bb', label: 'Other' }], currentRecentVaultId: 'aa',
  };
  await render(true);
  await act(async () => { await Promise.resolve(); });
  change({ activePath: 'Beta.md' });
  change({ activePath: 'Projects/Alpha.md' });
  popover!({ payload: { query: 'alp' } });
  const [label, event, state] = io.emitTo.mock.calls[0];
  expect([label, event]).toEqual(['tray', 'mesa://tray-popover-state']);
  expect(state.recents.map((f: { rel: string }) => f.rel)).toEqual(['Projects/Alpha.md', 'Beta.md']);
  expect(state.results).toEqual([{ rel: 'Projects/Alpha.md', title: 'Alpha', folder: 'Projects' }]);
  expect(state.vaults).toEqual([{ id: 'aa', label: 'Synthetic', current: true }, { id: 'bb', label: 'Other', current: false }]);
  expect(state.graph.nodes).toHaveLength(2);
  expect(state.graph.links).toHaveLength(1);
  expect(state.graph.nodes[state.graph.active].id).toBe('Projects/Alpha.md');
});

it('routes popover actions to the store and ignores stale targets', async () => {
  const st = {
    newNote: vi.fn(async () => {}), openDailyNote: vi.fn(async () => {}), openRecentVault: vi.fn(async () => {}),
    setSetting: vi.fn(), syncAll: vi.fn(async () => {}), setAgentOpen: vi.fn(), toggleGraphFull: vi.fn(),
  };
  io.state = { ...io.state, ...st, files: [file('Beta.md')], recentVaults: [{ id: 'aa', label: 'Synthetic' }] };
  await render(true);
  await act(async () => { await Promise.resolve(); });
  const sel = io.state.selectFile as ReturnType<typeof vi.fn>;
  action!({ payload: { action: 'note', rel: 'Beta.md' } });
  action!({ payload: { action: 'note', rel: 'Gone.md' } });
  action!({ payload: { action: 'vault', id: 'aa' } });
  action!({ payload: { action: 'vault', id: 'zz' } });
  action!({ payload: { action: 'search', query: 'beta' } });
  action!({ payload: { action: 'new-note' } });
  action!({ payload: { action: 'daily' } });
  action!({ payload: { action: 'sync-toggle' } });
  action!({ payload: { action: 'sync-now' } });
  action!({ payload: { action: 'pi' } });
  action!({ payload: { action: 'graph' } });
  expect(sel).toHaveBeenCalledExactlyOnceWith('Beta.md');
  expect(st.openRecentVault).toHaveBeenCalledExactlyOnceWith('aa');
  expect(io.state.openSearch).toHaveBeenCalledWith('beta');
  expect(st.newNote).toHaveBeenCalledOnce();
  expect(st.openDailyNote).toHaveBeenCalledOnce();
  expect(st.setSetting).toHaveBeenCalledWith('syncEnabled', !DEFAULT_SETTINGS.syncEnabled);
  // Sync now only runs while sync is on.
  expect(st.syncAll).toHaveBeenCalledTimes(DEFAULT_SETTINGS.syncEnabled ? 1 : 0);
  expect(st.setAgentOpen).toHaveBeenCalledWith(true);
  expect(st.toggleGraphFull).toHaveBeenCalledOnce();
});

it('removes a listener that resolves after unmount', async () => {
  let resolve!: (off: () => void) => void;
  io.listen.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await render(true);
  await act(async () => root.unmount()); root = createRoot(host);
  const late = vi.fn(); resolve(late);
  await act(async () => { await Promise.resolve(); });
  expect(late).toHaveBeenCalledOnce();
});
