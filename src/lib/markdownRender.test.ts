// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createMarkdownRenderer } from './markdownRender';
import { parseMarkdown } from './markdownParser';
import { renderMarkdown } from './markdown';
class FakeWorker {
  static latest: FakeWorker;
  messages: { id: number; source: string }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  constructor() { FakeWorker.latest = this; }
  postMessage(message: { id: number; source: string }) { this.messages.push(message); }
  reply(html: string) { this.onmessage?.({ data: { id: this.messages[this.messages.length - 1].id, blocks: [{ html }] } }); }
}
afterEach(() => vi.unstubAllGlobals());
it('keeps only the active and newest parse, rejects stale output, publishes blocks for the DOM sanitizer', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const publish = vi.fn(), fail = vi.fn();
  const renderer = createMarkdownRenderer(publish, fail);
  renderer.render('one'); renderer.render('two'); renderer.render('three');
  expect(FakeWorker.latest.messages.map(item => item.source)).toEqual(['one']);
  FakeWorker.latest.reply('<p>obsolete</p>');
  expect(publish).not.toHaveBeenCalled();
  expect(FakeWorker.latest.messages.map(item => item.source)).toEqual(['one', 'three']);
  FakeWorker.latest.reply('<img src=x onerror="evil()"><script>evil()</script><p>latest</p>');
  expect(publish).toHaveBeenCalledOnce();
  expect(publish.mock.calls[0][0][0].html).toContain('latest');
  // Sanitization belongs to markdownDom; parser output remains explicitly untrusted.
  renderer.dispose(); FakeWorker.latest.reply('<p>late</p>');
  expect(publish).toHaveBeenCalledOnce();
  expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('worker failure falls back to parsing the newest source', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const publish = vi.fn();
  const renderer = createMarkdownRenderer(publish, vi.fn());
  renderer.render('old'); renderer.render('# new <img src=x onerror="evil()">');
  FakeWorker.latest.onerror?.();
  expect(publish.mock.calls[0][0][0].html).toContain('new');
  renderer.dispose();
});
it('preserves whole-document references, raw HTML, callouts and task semantics', () => {
  const source = '---\ntitle: T\n---\n[reference][r]\n\n[r]: https://example.com\n\n> [!note] Title\n> [[Note]]\n\n- [x] **done**\n- [ ] next\n\n<div>raw</div>';
  const result = renderMarkdown(source);
  expect(parseMarkdown(source)).toContain('https://example.com');
  const host = document.createElement('div'); host.innerHTML = result;
  expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
  expect(host.querySelectorAll('input[disabled]')).toHaveLength(2);
  expect(host.querySelectorAll('input[checked]')).toHaveLength(1);
  expect(host.querySelector('.task-list strong')?.textContent).toBe('done');
  expect(host.querySelector('.callout .wikilink')?.textContent).toBe('Note');
  expect(host.querySelector('.properties')).not.toBeNull();
});
