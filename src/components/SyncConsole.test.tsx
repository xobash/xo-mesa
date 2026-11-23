// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select(state.value) }));
import { SyncConsole } from './SyncConsole';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);

beforeEach(() => {
  state.value = {
    syncLog: [{ ts: 0, level: 'info', msg: 'started' }], syncProgress: null, syncPhase: null, syncBusy: false,
    syncReport: null, syncLastPeerId: null, syncNow: vi.fn(), syncListening: false, settings: { ...DEFAULT_SETTINGS },
    files: [], vaultPath: '/v', clearSyncLog: vi.fn(),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('says Copied only after the clipboard accepted the log', async () => {
  let accept!: () => void;
  const writeText = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => root.render(<SyncConsole />));
  await act(async () => button('Copy log')!.click());
  expect(writeText).toHaveBeenCalledOnce();
  expect(button('Copied')).toBeUndefined();
  await act(async () => { accept(); });
  expect(button('Copied')).toBeDefined();
});

it('does not say Copied when every clipboard path refuses', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
  document.execCommand = () => false;
  await act(async () => root.render(<SyncConsole />));
  await act(async () => button('Copy log')!.click());
  expect(button('Copied')).toBeUndefined();
  expect(button('Copy log')).toBeDefined();
});
