// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { parseMarkdownBlocks } from './markdownParser';
import { sanitizeHtml } from './markdown';
it('keeps references document-wide while isolating paragraphs, tables, lists, code and callouts', () => {
  const blocks = parseMarkdownBlocks('[first][r]\n\nOther paragraph.\n\n> [!note] Title\n> [inside][r]\n\n- [x] done\n- next\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nhello\n```\n\n[r]: https://example.com');
  expect(blocks).toHaveLength(6);
  const host = document.createElement('div');host.innerHTML = blocks.map(b=>sanitizeHtml(b.html)).join('');
  expect(host.querySelectorAll('a[href="https://example.com"]')).toHaveLength(2);
  expect(host.querySelector('.callout-title')?.textContent).toBe('Title');
  expect(host.querySelector('ul input')?.hasAttribute('checked')).toBe(true);
  expect(host.querySelectorAll('table')).toHaveLength(1);
  expect(host.querySelector('pre code')?.textContent).toBe('hello\n');
});
it('changing a reference definition changes every dependent block', () => {
  const a = parseMarkdownBlocks('[one][r]\n\nUnchanged\n\n[two][r]\n\n[r]: https://one.example');
  const b = parseMarkdownBlocks('[one][r]\n\nUnchanged\n\n[two][r]\n\n[r]: https://two.example');
  expect(a[0]).not.toEqual(b[0]); expect(a[1]).toEqual(b[1]); expect(a[2]).not.toEqual(b[2]);
});
it('keeps raw HTML spanning Markdown boundaries in one sanitizer context', () => {
  const blocks = parseMarkdownBlocks('<div>\n\n**nested**\n\n</div>\n\nAfter');
  expect(blocks).toHaveLength(2);
  const host = document.createElement('div');host.innerHTML = blocks.map(b => sanitizeHtml(b.html)).join('');
  expect(host.querySelector('div strong')?.textContent).toBe('nested');
  expect(host.lastElementChild?.textContent).toBe('After');
});
it.each([
  '<div title="quoted > delimiter">\n\n**inside**\n\n</div>\n\nAfter',
  '<div>\n\nUnclosed\n\nAfter',
  '<!-- unclosed comment\n\nAfter',
  '<table><tr><td>cell</td></tr></table>\n\nAfter',
  '<script>if (a < b) evil()</script>\n\nAfter',
  '<svg><foreignObject><div>text</div></foreignObject></svg>\n\nAfter',
])('preserves sanitizer context for raw HTML: %s', source => {
  const blocks = parseMarkdownBlocks(source);
  const full = document.createElement('div'), incremental = document.createElement('div');
  full.innerHTML = sanitizeHtml(blocks.map(block => block.html).join(''));
  incremental.innerHTML = blocks.map(block => sanitizeHtml(block.html)).join('');
  expect(incremental.innerHTML).toBe(full.innerHTML);
});
