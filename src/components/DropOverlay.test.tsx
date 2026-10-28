// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Payload = { payload: unknown };
const io = vi.hoisted(() => ({
  handler: null as ((event: Payload) => void) | null,
  register: vi.fn(),
  importDropped: vi.fn(async () => {}),
  setState: vi.fn(),
}));
vi.mock('../lib/vault', () => ({ IN_TAURI: true }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: io.register }) }));
vi.mock('../store', () => {
  const use = (select: (state: Record<string, unknown>) => unknown) => select({ importDropped: io.importDropped });
  use.setState = io.setState;
  return { useAppStore: use };
});
import { DropOverlay } from './DropOverlay';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const unlisten = vi.fn();
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const fire = (payload: unknown) => act(async () => io.handler!({ payload }));
beforeEach(() => {
  io.register.mockImplementation(async (handler: (event: Payload) => void) => { io.handler = handler; return unlisten; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it('shows the drop target while dragging and imports dropped paths once', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  await act(async () => root.render(<DropOverlay />)); await settle();
  expect(host.querySelector('.drop-overlay')).toBeNull();
  await fire({ type: 'enter' });
  expect(host.textContent).toContain('Drop to add to your vault');
  await fire({ type: 'leave' });
  expect(host.querySelector('.drop-overlay')).toBeNull();
  await fire({ type: 'drop', paths: ['/tmp/a.md'] });
  await fire({ type: 'drop', paths: ['/tmp/a.md'] }); // native double-fire
  expect(io.importDropped).toHaveBeenCalledTimes(1);
  expect(io.importDropped).toHaveBeenCalledWith(['/tmp/a.md']);
  expect(host.querySelector('.drop-overlay')).toBeNull();
  vi.mocked(Date.now).mockReturnValue(20_000);
  await fire({ type: 'drop', paths: [] });
  expect(io.setState).toHaveBeenCalledWith({ status: 'Drop received no file paths.' });
  vi.restoreAllMocks();
});

it('removes a native listener that registers after unmount', async () => {
  let resolve!: (off: () => void) => void;
  io.register.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await act(async () => root.render(<DropOverlay />)); await settle();
  await act(async () => root.unmount()); root = createRoot(host);
  const late = vi.fn(); resolve(late); await settle();
  expect(late).toHaveBeenCalledOnce();
});

it('stops listening on unmount', async () => {
  await act(async () => root.render(<DropOverlay />)); await settle();
  await act(async () => root.unmount()); root = createRoot(host);
  expect(unlisten).toHaveBeenCalledOnce();
});
