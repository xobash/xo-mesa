// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  handler: undefined as undefined | ((event: { payload: unknown }) => void),
  setSetting: vi.fn(),
  autoUpdate: true,
  pending: 0,
  flushSave: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => { mocks.handler = handler; return () => {}; }),
}));
vi.mock('../store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ settings: { autoUpdate: mocks.autoUpdate }, setSetting: mocks.setSetting }),
  getStore: () => ({ flushSave: mocks.flushSave, textSaveState: { pending: mocks.pending }, dirtyBinaryPaths: [] }),
}));

import { UpdatesSection } from './UpdatesSection';
import { watchUpdates } from '../controllers/updates';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let seq = 0;
const status = (fields: Record<string, unknown>) => ({ seq: ++seq, currentVersion: '0.1.0', support: { kind: 'automatic' }, checkedAt: null, ...fields });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
const send = (fields: Record<string, unknown>) => act(async () => mocks.handler!({ payload: status(fields) }));
const line = () => host.querySelector('[role="status"]')!.textContent;

beforeAll(async () => {
  // The launch watcher runs before Settings ever opens.
  mocks.invoke.mockImplementation(async (command: string) => (command === 'updater_status' ? status({ state: 'idle' }) : undefined));
  watchUpdates({ autoCheck: false });
  await flush();
});
beforeEach(async () => {
  mocks.pending = 0; mocks.autoUpdate = true;
  mocks.invoke.mockClear(); mocks.setSetting.mockClear(); mocks.flushSave.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('shows the cached launch result on first render with when it was checked, without asking native code again', async () => {
  await send({ state: 'upToDate', checkedAt: Date.now() - 2 * 60_000 });
  mocks.invoke.mockClear();
  await act(async () => root.render(<UpdatesSection />));
  expect(line()).toBe('Mesa is up to date.');
  expect(host.querySelector('.update-icon-ok')).not.toBeNull();
  expect(host.querySelector('.update-checked')!.textContent).toBe('Checked 2 min ago');
  // The Updates group shows the installed version; this section does not.
  expect(host.textContent).not.toContain('0.1.0');
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('shows a download as a progress bar with its percent', async () => {
  await act(async () => root.render(<UpdatesSection />));
  await send({ state: 'downloading', version: '0.2.0', downloaded: 42, total: 100, percent: 42 });
  expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('42');
  expect(host.querySelector('.update-percent')!.textContent).toBe('42%');
  expect(button('Check now')!.disabled).toBe(true);
  await send({ state: 'error', message: "Couldn't reach the update server." });
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(line()).toBe("Couldn't reach the update server.");
  expect(button('Check now')!.disabled).toBe(false);
});

it('with automatic updates off, Check now only checks and offers Download and install', async () => {
  mocks.autoUpdate = false;
  await act(async () => root.render(<UpdatesSection />));
  await send({ state: 'upToDate' });
  await act(async () => button('Check now')!.click());
  expect(mocks.invoke).toHaveBeenCalledWith('updater_check', { download: false });
  await send({ state: 'available', version: '0.2.0' });
  expect(line()).toBe('Mesa 0.2.0 is available.');
  await act(async () => button('Download and install')!.click());
  expect(mocks.invoke).toHaveBeenCalledWith('updater_download');
  await send({ state: 'downloading', version: '0.2.0', downloaded: 1, total: 10, percent: 10 });
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(button('Download and install')).toBeUndefined();
});

it('installs that need an administrator get the version and how, never a download button', async () => {
  await act(async () => root.render(<UpdatesSection />));
  await send({ state: 'available', version: '0.2.0', support: { kind: 'notifyOnly', reason: 'Install it with your package manager.' } });
  expect(line()).toBe('Mesa 0.2.0 is available. Install it with your package manager.');
  expect(button('Download and install')).toBeUndefined();
});

it('turning Automatic updates off cancels a running download', async () => {
  await act(async () => root.render(<UpdatesSection />));
  await send({ state: 'downloading', version: '0.2.0', downloaded: 1, total: 10, percent: 10 });
  const toggle = host.querySelector('[role="switch"][aria-label="Automatic updates"]') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle.click());
  expect(mocks.setSetting).toHaveBeenCalledWith('autoUpdate', false);
  expect(mocks.invoke).toHaveBeenCalledWith('updater_cancel');
});

it('Restart to update never restarts while an edit is unsaved', async () => {
  await act(async () => root.render(<UpdatesSection />));
  await send({ state: 'ready', version: '0.2.0' });
  expect(line()).toBe('Mesa 0.2.0 is ready. It installs when you quit Mesa.');
  mocks.pending = 1;
  await act(async () => button('Restart to update')!.click());
  expect(mocks.flushSave).toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalledWith('updater_restart');
  expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/not saved/);
});

it('Restart to update saves first, then restarts', async () => {
  await act(async () => root.render(<UpdatesSection />));
  await send({ state: 'ready', version: '0.2.0' });
  await act(async () => button('Restart to update')!.click());
  expect(mocks.flushSave).toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith('updater_restart');
});
