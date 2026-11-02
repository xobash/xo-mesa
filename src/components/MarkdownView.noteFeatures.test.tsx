// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownView } from './MarkdownView';
import { parseMarkdownBlocks } from '../lib/markdownParser';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class WorkerStub {
  onmessage?: (event: { data: unknown }) => void;
  terminate = vi.fn();
  postMessage(message: { id: number; source: string }) {
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, blocks: parseMarkdownBlocks(message.source) } }));
  }
}
afterEach(() => { vi.unstubAllGlobals(); });

it('typesets math after insertion and jumps to footnotes inside the same preview only', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const host = document.createElement('div'); document.body.append(host);
  // A second element with the same id elsewhere in the app must not be the jump target.
  const decoy = document.createElement('li'); decoy.id = 'fn1'; document.body.prepend(decoy);
  decoy.scrollIntoView = vi.fn();
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<MarkdownView source={'Energy $E=mc^2$.[^1]\n\n[^1]: Einstein, 1905.'} />); });
    await vi.waitFor(() => expect(host.querySelector('.math-inline .katex')).not.toBeNull());
    // Look up by attribute: jsdom resolves a duplicate `#id` selector document-wide.
    const footnote = () => host.querySelector<HTMLElement>('li.footnote-item[id="fn1"]');
    await vi.waitFor(() => expect(footnote()).not.toBeNull());
    const note = footnote()!;
    note.scrollIntoView = vi.fn();
    const ref = host.querySelector<HTMLAnchorElement>('sup.footnote-ref a')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { ref.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(note.scrollIntoView).toHaveBeenCalled();
    expect(decoy.scrollIntoView).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount()); host.remove(); decoy.remove();
  }
});
