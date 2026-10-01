// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createMarkdownDom, type MarkdownRenderStats } from './markdownDom';
import { parseMarkdownBlocks } from './markdownParser';

function fixture() {
  const host = document.createElement('div');
  const jobs = new Set<() => void>();
  let stats: MarkdownRenderStats | undefined;
  const dom = createMarkdownDom(host, {
    schedule: job => { jobs.add(job); return () => { jobs.delete(job); }; },
    onComplete: value => { stats = value; },
  });
  const tick = () => { const job = jobs.values().next().value; if (job) { jobs.delete(job); job(); } };
  const drain = () => { let n = 0; while (jobs.size) { if (++n > 10000) throw Error('stuck'); tick(); } };
  return { host, dom, jobs, tick, drain, stats: () => stats! };
}
it('sanitizes one edited paragraph, preserves other nodes and selection, and keeps exact order', () => {
  const f = fixture(); document.body.append(f.host);
  const source = Array.from({length: 100}, (_, i) => `Paragraph ${i}.`).join('\n\n');
  f.dom.update(parseMarkdownBlocks(source)); f.drain();
  const originals = [...f.host.querySelectorAll('p')];
  const selection = getSelection()!; const range = document.createRange();
  range.selectNodeContents(originals[70]); selection.addRange(range);
  f.dom.update(parseMarkdownBlocks(source.replace('Paragraph 50.', 'Edited paragraph.'))); f.drain();
  expect(f.stats()).toMatchObject({ reused: 99, sanitized: 1, removed: 2 });
  expect(f.host.querySelectorAll('p')[70]).toBe(originals[70]);
  expect(selection.toString()).toBe('Paragraph 70.');
  expect(f.host.querySelectorAll('p')[50].textContent).toBe('Edited paragraph.');
  f.dom.dispose(); f.host.remove();
});
it('yields on initial rendering, rejects superseded slices and disposes pending work', () => {
  const f = fixture();
  f.dom.update(parseMarkdownBlocks(Array.from({length: 100}, (_, i) => `Old ${i}`).join('\n\n')));
  f.tick(); expect(f.host.querySelectorAll('p').length).toBeLessThan(100);
  expect(f.host.getAttribute('aria-busy')).toBe('true');
  f.dom.pending(); f.dom.update(parseMarkdownBlocks('Newest')); f.drain();
  expect(f.host.textContent).toBe('Newest\n');
  expect(f.host.getAttribute('aria-busy')).toBe('false');
  f.dom.update(parseMarkdownBlocks('Discarded')); f.dom.dispose(); f.drain();
  expect(f.host.textContent).toBe('');
});
it('handles insertions, deletion, duplicate paragraphs and reordering without replacing unchanged nodes', () => {
  const f = fixture(); f.dom.update(parseMarkdownBlocks('A\n\nB\n\nA')); f.drain();
  const [a,b,a2] = f.host.querySelectorAll('p');
  f.dom.update(parseMarkdownBlocks('Before\n\nA\n\nA\n\nB')); f.drain();
  expect([...f.host.querySelectorAll('p')].slice(1)).toEqual([a,a2,b]);
  f.dom.update([]); f.drain(); expect(f.host.childNodes.length).toBe(0);
});
it('never inserts unsanitized worker markup and bounds cache retention', () => {
  const f = fixture();
  f.dom.update([{ html: '<img src=x onerror="evil()"><script>evil()</script><p>safe</p>' }]); f.drain();
  expect(f.host.innerHTML).not.toMatch(/evil|onerror|script/);
  for (let i=0;i<280;i++) { f.dom.update([{html:`<p>${i}${'x'.repeat(5000)}</p>`}]); f.drain(); }
  expect(f.stats().cacheChars).toBeLessThanOrEqual(1024 * 1024);
});
it('reports sanitizer failures without leaving the preview permanently busy', () => {
  const host = document.createElement('div'); const failure = vi.fn();
  let work = () => {};
  const dom = createMarkdownDom(host, { schedule: run => { work = run; return () => {}; }, sanitize: () => { throw Error('bad'); }, onError: failure });
  dom.update([{html:'x'}]); work(); expect(failure).toHaveBeenCalledOnce();
  expect(host.getAttribute('aria-busy')).toBe('false'); dom.dispose();
});
it('clears busy state on parser failure and cancels pending DOM publication', () => {
  const f = fixture(); f.dom.update(parseMarkdownBlocks('obsolete')); f.dom.fail(); f.drain();
  expect(f.host.textContent).toBe(''); expect(f.host.getAttribute('aria-busy')).toBe('false');
  f.dom.update(parseMarkdownBlocks('recovered')); f.drain(); expect(f.host.textContent).toContain('recovered');
});
it('bounds sanitizer work for one edit in a ten-thousand-block document', () => {
  const f = fixture();
  const blocks = Array.from({length:10000}, (_, i) => ({html:`<p>Paragraph ${i}</p>\n`}));
  f.dom.update(blocks); f.drain();
  expect(f.stats().slices).toBeGreaterThanOrEqual(625);
  const last = f.host.lastChild;
  const edited = [...blocks]; edited[5000] = {html:'<p>Changed</p>\n'};
  f.dom.update(edited); f.drain();
  expect(f.stats()).toMatchObject({sanitized:1, sanitizedChars:15, reused:9999, inserted:2, removed:2});
  expect(f.host.lastChild).toBe(last);
});
it('preserves backwards selection and focus when unchanged blocks move', () => {
  const f = fixture(); document.body.append(f.host);
  f.dom.update([{html:'<p>A</p>'},{html:'<p><a href="#">Selected</a></p>'}]); f.drain();
  const link = f.host.querySelector('a')!; link.focus();
  const text = link.firstChild!; const selection = getSelection()!;
  selection.setBaseAndExtent(text, 7, text, 0);
  f.dom.update([{html:'<p><a href="#">Selected</a></p>'},{html:'<p>A</p>'}]); f.drain();
  expect(selection.toString()).toBe('Selecte'); expect(selection.anchorOffset).toBe(7);
  expect(document.activeElement).toBe(link); f.dom.dispose(); f.host.remove();
});
