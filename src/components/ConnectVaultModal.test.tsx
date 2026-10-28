// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { DiscoveryPacket } from '../lib/syncUi';

const io = vi.hoisted(() => ({
  calls: [] as string[],
  listen: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  fetchInfo: vi.fn(),
  receive: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock('../store', () => {
  const use = (select: (state: Record<string, unknown>) => unknown) => select(io.state);
  use.getState = () => io.state;
  return { useAppStore: use };
});
vi.mock('../lib/vault', () => ({ IN_TAURI: true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: io.listen }));
vi.mock('../lib/syncUi', async (original) => ({
  ...await original<object>(),
  startSyncDiscovery: io.start,
  stopSyncDiscovery: io.stop,
  fetchRemoteVaultInfo: io.fetchInfo,
}));
vi.mock('./Modal', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { ConnectVaultModal } from './ConnectVaultModal';
import { syncDiscovery } from '../lib/serialResource';

type Handler = (event: { payload: DiscoveryPacket }) => void;
let handlers: Handler[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const packet = (name: string, host: string): DiscoveryPacket => ({ mesaDiscovery: true, version: '1', name, host, port: 8787, protocol: 'https', listening: true, fingerprint: 'a'.repeat(64) });

let hosts: HTMLDivElement[] = [];
let roots: ReturnType<typeof createRoot>[] = [];
async function mount() {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); hosts.push(host); roots.push(root);
  await act(async () => { root.render(<ConnectVaultModal onClose={vi.fn()} />); });
  return { host, unmount: () => act(async () => root.unmount()) };
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

beforeEach(() => {
  io.calls = []; handlers = [];
  io.listen.mockImplementation(async (_name: string, handler: Handler) => {
    io.calls.push('listen'); handlers.push(handler);
    return () => { io.calls.push('unlisten'); handlers = handlers.filter((h) => h !== handler); };
  });
  io.start.mockImplementation(async (_n: string, _p: number, listening: boolean) => { io.calls.push(`start ${listening}`); });
  io.stop.mockImplementation(async () => { io.calls.push('stop'); });
  io.state = {
    vaultName: '', settings: { ...DEFAULT_SETTINGS, syncToken: '' },
    receiveSharedVault: io.receive, loadSyncSecrets: async () => {},
  };
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  hosts.forEach((h) => h.remove()); hosts = []; roots = [];
  await settle(); vi.clearAllMocks();
});

it('starts no discovery until the user asks, then lists sharing devices only', async () => {
  const { host } = await mount();
  await settle();
  expect(io.listen).not.toHaveBeenCalled(); expect(io.start).not.toHaveBeenCalled();
  expect(host.textContent).toContain('stops when this dialog');
  await act(async () => button(host, 'Search nearby devices').click());
  await settle();
  expect(io.calls).toEqual(['listen', 'start false']);
  await act(async () => {
    handlers.forEach((h) => h({ payload: packet('Desk', '192.0.2.10') }));
    handlers.forEach((h) => h({ payload: { ...packet('Laptop', '192.0.2.11'), listening: false } }));
  });
  expect(host.textContent).toContain('Desk'); expect(host.textContent).not.toContain('Laptop');
});

it('unmounting before listen resolves removes the listener and never announces', async () => {
  const pending = deferred<() => void>(); const unlisten = vi.fn();
  io.listen.mockImplementationOnce(() => pending.promise);
  const { host, unmount } = await mount();
  await act(async () => button(host, 'Search nearby devices').click());
  await unmount();
  pending.resolve(unlisten); await settle();
  expect(unlisten).toHaveBeenCalledOnce(); expect(io.start).not.toHaveBeenCalled();
});

it('unmounting while start is pending ends with a stop', async () => {
  const started = deferred<void>();
  io.start.mockImplementationOnce(async () => { io.calls.push('start'); await started.promise; });
  const { host, unmount } = await mount();
  await act(async () => button(host, 'Search nearby devices').click());
  await settle(); await unmount();
  started.resolve(); await settle();
  expect(io.calls).toEqual(['listen', 'start', 'unlisten', 'stop']);
});

it('closing this dialog keeps another holder discovering with its own config', async () => {
  const releaseSync = syncDiscovery({ name: 'Desk', port: 8787, listening: true }, () => {});
  await settle();
  const { host, unmount } = await mount();
  await act(async () => button(host, 'Search nearby devices').click());
  await settle(); await unmount(); await settle();
  expect(io.calls).toEqual(['listen', 'start true', 'listen', 'stop', 'start false', 'unlisten', 'stop', 'start true']);
  releaseSync(); await settle();
  expect(io.calls.slice(-2)).toEqual(['unlisten', 'stop']);
});

it('probes a manual address with the typed key before offering download', async () => {
  io.fetchInfo.mockResolvedValue({ files: 3, bytes: 2048, fingerprint: 'b'.repeat(64) });
  const { host } = await mount();
  const [address, key] = [...host.querySelectorAll('input')];
  const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  expect(button(host, 'Connect').disabled).toBe(true);
  await act(async () => { type(address, '192.0.2.20'); type(key, 'secret'); });
  await act(async () => button(host, 'Connect').click());
  expect(io.fetchInfo).toHaveBeenCalledWith(expect.stringContaining('192.0.2.20'), 'secret');
  expect(host.textContent).toContain('3 files · 2 KB');
  io.receive.mockResolvedValue(null);
  await act(async () => button(host, 'Choose folder').click());
  expect(io.receive).toHaveBeenCalledWith(expect.objectContaining({ token: 'secret', fingerprint: 'b'.repeat(64) }));
  expect(button(host, 'Choose folder')).toBeTruthy();
});
