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
