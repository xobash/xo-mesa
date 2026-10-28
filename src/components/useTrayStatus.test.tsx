// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  subscribers: new Set<() => void>(),
  state: {} as Record<string, unknown>,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: io.listen }));
vi.mock('../store', () => ({
  getStore: () => io.state,
  useAppStore: { subscribe: (fn: () => void) => { io.subscribers.add(fn); return () => io.subscribers.delete(fn); } },
}));
import { useTrayStatus } from './useTrayStatus';

type Action = { payload: { action: string; rel?: string } };
let action: ((event: Action) => void) | null = null;
const unlisten = vi.fn();
function Probe({ enabled }: { enabled: boolean }) { useTrayStatus(enabled); return null; }
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
async function render(enabled: boolean) { await act(async () => { root.render(<Probe enabled={enabled} />); }); }
function change(patch: Record<string, unknown>) { io.state = { ...io.state, ...patch }; io.subscribers.forEach((fn) => fn()); }
const sent = () => io.invoke.mock.calls.map(([, args]) => (args as { snapshot: { vault: string | null; sync: string } }).snapshot);

beforeEach(() => {
  vi.useFakeTimers();
  io.invoke.mockResolvedValue(undefined);
  io.listen.mockImplementation(async (_name: string, handler: (event: Action) => void) => { action = handler; return unlisten; });
  io.state = {
    vaultPath: '/vault', vaultName: 'Synthetic', textSaveState: { pending: 0, saving: 0, failed: 0 },
    notes: {}, contentCache: {}, settings: { ...DEFAULT_SETTINGS }, deepResearch: null, syncBusy: false,
    openSearch: vi.fn(), setTasksOpen: vi.fn(), setSettingsOpen: vi.fn(), selectFile: vi.fn(async () => {}),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.useRealTimers(); vi.clearAllMocks(); io.subscribers.clear(); action = null;
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
  expect(unlisten).toHaveBeenCalledOnce();
  expect(io.subscribers.size).toBe(0);
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
