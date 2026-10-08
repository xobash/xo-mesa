// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownView } from './MarkdownView';
import { parseMarkdownBlocks } from '../lib/markdownParser';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class WorkerStub {
  static latest: WorkerStub | undefined;
  messages: { id: number; source: string }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  terminate = vi.fn();
  constructor() { WorkerStub.latest = this; }
  postMessage(message: { id: number; source: string }) { this.messages.push(message); }
  reply() {
    const job = this.messages[this.messages.length - 1];
    this.onmessage?.({ data: { id: job.id, blocks: parseMarkdownBlocks(job.source) } });
  }
}
afterEach(() => { vi.unstubAllGlobals(); WorkerStub.latest = undefined; });
it('renders latest worker text, sanitized tasks and delegated links, then releases the worker', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), open = vi.fn();
  try {
    await act(async () => { root.render(<MarkdownView source="old" onWikiClick={open} />); });
    await vi.waitFor(() => expect(WorkerStub.latest).toBeDefined());
    const worker = WorkerStub.latest!;
    await act(async () => { root.render(<MarkdownView source={'[[new]]\n\n- [x] done\n\n<img src=x onerror="evil()">'} onWikiClick={open} />); });
    act(() => worker.reply());
    expect(host.textContent).not.toContain('old');
    act(() => worker.reply());
    await act(async () => { await vi.waitFor(() => expect(host.querySelector('input')?.disabled).toBe(true)); });
    expect(host.querySelector('input')?.checked).toBe(true);
    expect(host.innerHTML).not.toContain('onerror');
    act(() => host.querySelector<HTMLElement>('.wikilink')!.click());
    expect(open).toHaveBeenCalledWith('new');
    act(() => root.unmount());
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally { host.remove(); }
});

async function mounted(source: string, props: Partial<Parameters<typeof MarkdownView>[0]> = {}) {
  vi.stubGlobal('Worker', WorkerStub);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<MarkdownView source={source} {...props} />); });
  await vi.waitFor(() => expect(WorkerStub.latest).toBeDefined());
  act(() => WorkerStub.latest!.reply());
  return { host, root };
}

it('routes external links away from the app webview and blocks other schemes', async () => {
  const external = vi.fn(), open = vi.fn();
  const { host, root } = await mounted(
    '[web](https://evil.example/x) [note](sub/other%20note.md) <a href="javascript:evil()">js</a> <a href="tauri://localhost/x">t</a>',
    { onExternalLink: external, onWikiClick: open },
  );
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('a').length).toBeGreaterThan(1));
    const events: boolean[] = [];
    for (const a of host.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(event);
      events.push(event.defaultPrevented);
    }
    expect(events.every(Boolean)).toBe(true);
    expect(external).toHaveBeenCalledExactlyOnceWith('https://evil.example/x');
    expect(open).toHaveBeenCalledExactlyOnceWith('sub/other note');
  } finally { act(() => root.unmount()); host.remove(); }
});

it('does not request remote images until the reader consents', async () => {
  const { host, root } = await mounted('![x](https://tracker.example/p.gif)\n\n<img src="//cdn.example/a.png">');
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('img[data-remote-src]')).toHaveLength(2));
    for (const img of host.querySelectorAll('img')) expect(img.getAttribute('src')).toBeNull();
    expect(host.innerHTML).not.toMatch(/\ssrc="(https?:)?\/\//);
    const button = [...host.querySelectorAll('button')].find(b => /remote images/i.test(b.textContent ?? ''))!;
    await act(async () => { button.click(); });
    await vi.waitFor(() => {
      const srcs = [...host.querySelectorAll('img')].map(img => img.getAttribute('src'));
      expect(srcs).toEqual(['https://tracker.example/p.gif', '//cdn.example/a.png']);
    });
  } finally { act(() => root.unmount()); host.remove(); }
});
