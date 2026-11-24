import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  handler: undefined as undefined | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => { native.handler = handler; return native.unlisten; }),
}));

import { cancelUpdateDownload, checkForUpdates, downloadUpdate, getUpdateStatus, subscribeUpdateStatus, watchUpdates } from './updates';

// The cache keeps the newest status for the whole file, so every payload
// here carries a higher sequence number than the one before.
let seq = 0;
const status = (fields: Record<string, unknown> = {}) => ({ seq: ++seq, currentVersion: '0.1.0', support: { kind: 'automatic' }, state: 'upToDate', checkedAt: 1, ...fields });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const commands = () => native.invoke.mock.calls.map(([command]) => command);

beforeEach(() => {
  native.invoke.mockReset().mockImplementation(async () => status());
  native.unlisten.mockReset();
  native.handler = undefined;
});
afterEach(() => vi.useRealTimers());

it('with automatic updates off, the launch makes no update check', async () => {
  const schedule = vi.fn(() => () => {});
  const stop = watchUpdates({ autoCheck: false, schedule });
  await flush();
  expect(commands()).toEqual(['updater_status']);
  expect(schedule).not.toHaveBeenCalled();
  stop();
});

it('with automatic updates on, checks and downloads once the window has settled', async () => {
  let run: (() => void) | undefined;
  const stop = watchUpdates({ autoCheck: true, schedule: (callback) => { run = callback; return () => {}; } });
  await flush();
  expect(commands()).not.toContain('updater_check');
  run!();
  await flush();
  expect(native.invoke).toHaveBeenCalledWith('updater_check', { download: true });
  stop();
});

it('a closed window never starts the scheduled check', async () => {
  let run: (() => void) | undefined;
  const cancel = vi.fn();
  const stop = watchUpdates({ autoCheck: true, schedule: (callback) => { run = callback; return cancel; } });
  await flush();
  stop();
  expect(cancel).toHaveBeenCalled();
  expect(native.unlisten).toHaveBeenCalled();
  run!();
  await flush();
  expect(commands()).not.toContain('updater_check');
});

it('the default launch check waits for the delay, not for startup', async () => {
  vi.useFakeTimers();
  const stop = watchUpdates({ autoCheck: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(commands()).not.toContain('updater_check');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(native.invoke).toHaveBeenCalledWith('updater_check', { download: true });
  stop();
});

it('native status events update the cached status and notify subscribers', async () => {
  const seen: string[] = [];
  const unsubscribe = subscribeUpdateStatus(() => seen.push(getUpdateStatus().state));
  const stop = watchUpdates({ autoCheck: false, schedule: () => () => {} });
  await flush();
  native.handler!({ payload: status({ state: 'downloading', version: '0.2.0', downloaded: 1, total: 4, percent: 25 }) });
  expect(getUpdateStatus()).toMatchObject({ state: 'downloading', percent: 25 });
  expect(seen).toEqual(['upToDate', 'downloading']);
  unsubscribe();
  stop();
});

it('an older status arriving late never replaces a newer one', async () => {
  const stop = watchUpdates({ autoCheck: false, schedule: () => () => {} });
  await flush();
  // The check reply ("checking") is built before a fast failure event but
  // delivered after it.
  const checking = status({ state: 'checking' });
  const failed = status({ state: 'error', message: "Couldn't reach the update server." });
  let reply: (value: unknown) => void = () => {};
  native.invoke.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = checkForUpdates(false);
  native.handler!({ payload: failed });
  reply(checking);
  await pending;
  expect(getUpdateStatus()).toMatchObject({ state: 'error', seq: failed.seq });
  stop();
});

it('check only, download on request and cancel use their own commands', async () => {
  await checkForUpdates(false);
  expect(native.invoke).toHaveBeenLastCalledWith('updater_check', { download: false });
  await downloadUpdate();
  expect(native.invoke).toHaveBeenLastCalledWith('updater_download');
  await cancelUpdateDownload();
  expect(native.invoke).toHaveBeenLastCalledWith('updater_cancel');
});

it('a failed check shows a plain error instead of throwing', async () => {
  native.invoke.mockRejectedValueOnce('This operation belongs to the main workspace');
  await checkForUpdates(true);
  expect(getUpdateStatus()).toMatchObject({ state: 'error', message: 'This operation belongs to the main workspace' });
});
