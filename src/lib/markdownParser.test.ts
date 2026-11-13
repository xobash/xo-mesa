// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { parseMarkdown, parseMarkdownBlocks } from './markdownParser';
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
// Captured from the scanning implementation before failed openers were memoised.
const MATH_CASES: [string, string][] = [
  ["costs $5 and $x^2$ here", "<p>costs <span class=\"math math-inline\">5 and $x^2</span> here</p>\n"],
  ["$x$", "<p><span class=\"math math-inline\">x</span></p>\n"],
  ["$$x$$", "<div class=\"math math-block\">x</div>\n"],
  ["$ x$", "<p>$ x$</p>\n"],
  ["$x $", "<p>$x $</p>\n"],
  ["$5 and $10", "<p>$5 and $10</p>\n"],
  ["\\$x$", "<p>$x$</p>\n"],
  ["$x\\$", "<p>$x$</p>\n"],
  ["$x\\\\$", "<p><span class=\"math math-inline\">x\\\\</span></p>\n"],
  ["$x\\\\\\$ y$", "<p><span class=\"math math-inline\">x\\\\\\$ y</span></p>\n"],
  ["$$a$$ and $b$", "<p><span class=\"math math-display\">a</span> and <span class=\"math math-inline\">b</span></p>\n"],
  ["$$$", "<p>$$$</p>\n"],
  ["$$$$", "<div class=\"math math-block\"></div>\n"],
  ["$$ $$", "<div class=\"math math-block\"></div>\n"],
  ["$a$$b$", "<p><span class=\"math math-inline\">a</span><span class=\"math math-inline\">b</span></p>\n"],
  ["$$a$ b$$", "<div class=\"math math-block\">a$ b</div>\n"],
  ["$a$1 b$", "<p><span class=\"math math-inline\">a$1 b</span></p>\n"],
  ["$a$1", "<p>$a$1</p>\n"],
  ["unclosed $x and more", "<p>unclosed $x and more</p>\n"],
  ["costs $12.00 today\ncosts $12.00 today\nthen $y$ end", "<p>costs <span class=\"math math-inline\">12.00 today\ncosts $12.00 today\nthen $y</span> end</p>\n"],
  ["a $$x and $$ later $$y$$", "<p>a <span class=\"math math-display\">x and </span> later <span class=\"math math-display\">y</span></p>\n"],
  ["$x$$", "<p><span class=\"math math-inline\">x</span>$</p>\n"],
  ["$$x$", "<p>$<span class=\"math math-inline\">x</span></p>\n"],
  ["pre \\\\$x$ post", "<p>pre \\<span class=\"math math-inline\">x</span> post</p>\n"],
  ["[$a](u) $b$", "<p>[<span class=\"math math-inline\">a](u) $b</span></p>\n"],
  ["[link $x](u) $y$", "<p>[link <span class=\"math math-inline\">x](u) $y</span></p>\n"],
  ["`$x$` $y$", "<p><code>$x$</code> <span class=\"math math-inline\">y</span></p>\n"],
  ["$a `b` c$", "<p><span class=\"math math-inline\">a `b` c</span></p>\n"],
  ["$a$b$c$", "<p><span class=\"math math-inline\">a</span>b<span class=\"math math-inline\">c</span></p>\n"],
  ["x$$ $y$", "<p>x$$ <span class=\"math math-inline\">y</span></p>\n"],
  ["$5 $6 $7 $z$", "<p><span class=\"math math-inline\">5 $6 $7 $z</span></p>\n"],
  ["$$5 $$6 $$z$$", "<div class=\"math math-block\">5 $$6 $$z</div>\n"],
  ["$\\$$", "<p><span class=\"math math-inline\">\\$</span></p>\n"],
  ["$a\\$b$", "<p><span class=\"math math-inline\">a\\$b</span></p>\n"],
  ["*$a* b$", "<p>*<span class=\"math math-inline\">a* b</span></p>\n"],
  ["$x$5 $y$", "<p><span class=\"math math-inline\">x$5 $y</span></p>\n"],
  ["$5 $x$5 $y$", "<p><span class=\"math math-inline\">5 $x$5 $y</span></p>\n"],
  ["$a\\ $b$", "<p><span class=\"math math-inline\">a\\ $b</span></p>\n"],
  ["p $5 $$x$$", "<p>p <span class=\"math math-inline\">5 $</span>x$$</p>\n"],
  ["p $$5 and $y$", "<p>p $<span class=\"math math-inline\">5 and $y</span></p>\n"],
  ["p $5 x $$y$$ $z$", "<p>p <span class=\"math math-inline\">5 x $</span>y$$ <span class=\"math math-inline\">z</span></p>\n"],
  ["x $a [b $c](u) d", "<p>x $a <a href=\"u\">b $c</a> d</p>\n"],
  ["x [$a $5](u) $b$", "<p>x [<span class=\"math math-inline\">a $5](u) $b</span></p>\n"],
  ["x [$5 $6](u) $7 $b$", "<p>x [<span class=\"math math-inline\">5 $6](u) $7 $b</span></p>\n"],
  ["p $$a [b](u) $$c$$", "<p>p <span class=\"math math-display\">a [b](u) </span>c$$</p>\n"],
  ["*x $5* $y$", "<p>*x <span class=\"math math-inline\">5* $y</span></p>\n"],
  ["p $5\\$ q $6", "<p>p $5$ q $6</p>\n"],
  ["p $a\\\\$ $b$", "<p>p <span class=\"math math-inline\">a\\\\</span> <span class=\"math math-inline\">b</span></p>\n"],
  ["p $1 \\$ $2 $x$ $3", "<p>p <span class=\"math math-inline\">1 \\$ $2 $x</span> $3</p>\n"],
];
it('renders inline and display math delimiters exactly as before', () => {
  for (const [source, html] of MATH_CASES) expect([source, parseMarkdown(source)]).toEqual([source, html]);
});
// Equal total input per side (eight eighth-size runs, one full-size run), interleaved,
// best of five. Linear parsing gives a ratio near 1; quadratic parsing about 8.
const expectLinear = (input: (size: number) => string) => {
  const small = input(128 * 1024 / 8), large = input(128 * 1024);
  const work = (text: string, reps: number) => {
    const start = performance.now();
    for (let i = 0; i < reps; i++) parseMarkdownBlocks(text);
    return performance.now() - start;
  };
  const reps = Math.ceil(20 / Math.max(work(large, 1), 0.1));
  let smallBest = Infinity, largeBest = Infinity;
  for (let round = 0; round < 5; round++) {
    smallBest = Math.min(smallBest, work(small, 8 * reps));
    largeBest = Math.min(largeBest, work(large, reps));
  }
  expect(largeBest / smallBest).toBeLessThan(4);
};
it('parses a paragraph of unclosed currency dollars in linear time', () => {
  expectLinear(size => 'costs $12.00 today\n'.repeat(size / 19));
}, 60000);
it('returns every block of a note with 200,000 top-level paragraphs', () => {
  const blocks = parseMarkdownBlocks(Array.from({ length: 200_000 }, (_, i) => `p${i}`).join('\n\n'));
  expect(blocks).toHaveLength(200_000);
  expect(blocks[199_999].html).toBe('<p>p199999</p>\n');
}, 60000);
