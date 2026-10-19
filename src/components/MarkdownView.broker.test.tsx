// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, args: { token: string | null }) => (args.token ? null : 'tok')) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  convertFileSrc: (_path: string, scheme: string) => `${scheme}://localhost/`,
}));
vi.mock('../lib/vault', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/vault')>()), IN_TAURI: true }));
import { MarkdownView } from './MarkdownView';
import { parseMarkdownBlocks } from '../lib/markdownParser';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class WorkerStub {
  static latest: WorkerStub | undefined;
  onmessage?: (event: { data: unknown }) => void;
  terminate = vi.fn();
  constructor() { WorkerStub.latest = this; }
  postMessage(message: { id: number; source: string }) {
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, blocks: parseMarkdownBlocks(message.source) } }));
  }
}
afterEach(() => { vi.unstubAllGlobals(); WorkerStub.latest = undefined; });

it('loads consented desktop media only through the window image broker and revokes it on unmount', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<MarkdownView source={'![x](https://tracker.example/p.gif)\n\n<img srcset="//cdn.example/a.png 2x">'} />); });
    await vi.waitFor(() => expect(host.querySelector('.md-remote-notice button')).not.toBeNull());
    expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>('.md-remote-notice button')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toBe('mesa-web://localhost/tok?u=https%3A%2F%2Ftracker.example%2Fp.gif'));
    expect(host.querySelectorAll('img')[1].getAttribute('srcset')).toBe('mesa-web://localhost/tok?u=https%3A%2F%2Fcdn.example%2Fa.png 2x');
    expect(host.innerHTML).not.toMatch(/\s(src|srcset)="(https?:)?\/\//);
  } finally {
    act(() => root.unmount()); host.remove();
  }
  expect(native.invoke).toHaveBeenLastCalledWith('browse_resource_session', { token: 'tok' });
});
