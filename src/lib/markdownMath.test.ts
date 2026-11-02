// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseMarkdown, parseMarkdownBlocks } from './markdownParser';
import { sanitizeHtml } from './markdown';
import { enhanceMarkdown } from './markdownEnhance';

const render = (source: string) => {
  const host = document.createElement('div');
  host.innerHTML = sanitizeHtml(parseMarkdown(source));
  return host;
};

describe('math parsing', () => {
  it('emits escaped TeX placeholders for inline, inline display and block math', () => {
    const host = render('Euler: $e^{i\\pi} + 1 = 0$ and $$\\sum_i x_i$$\n\n$$\na < b\n\\\\ c\n$$');
    expect(host.querySelector('.math-inline')?.textContent).toBe('e^{i\\pi} + 1 = 0');
    expect(host.querySelector('.math-display')?.textContent).toBe('\\sum_i x_i');
    expect(host.querySelector('div.math-block')?.textContent).toBe('a < b\n\\\\ c');
  });

  it('keeps prices, escaped dollars and code spans as text', () => {
    expect(render('It costs $5 and $10 today.').querySelector('.math')).toBeNull();
    expect(render('Not \\$math$ here.').querySelector('.math')).toBeNull();
    const host = render('`$x$` stays code. A $ lone sign.');
    expect(host.querySelector('.math')).toBeNull();
    expect(host.querySelector('code')?.textContent).toBe('$x$');
  });

  it('requires tight delimiters for inline math', () => {
    expect(render('$ x$').querySelector('.math')).toBeNull();
    expect(render('$x $').querySelector('.math')).toBeNull();
    expect(render('$x$2').querySelector('.math')).toBeNull();
    expect(render('$x$, then').querySelector('.math-inline')?.textContent).toBe('x');
  });

  it('accepts one-line blocks and leaves unclosed blocks as text', () => {
    expect(render('$$ x^2 $$').querySelector('div.math-block')?.textContent).toBe('x^2');
    const open = render('$$\nx^2\n\nno close');
    expect(open.querySelector('.math-block')).toBeNull();
    expect(open.textContent).toContain('no close');
  });

  it('escapes HTML inside TeX before sanitization', () => {
    const html = parseMarkdown('$<img src=x onerror=alert(1)>$');
    expect(html).not.toContain('<img');
    expect(render('$<img src=x onerror=alert(1)>$').querySelector('img')).toBeNull();
  });

  it('keeps a math block as its own preview block', () => {
    const blocks = parseMarkdownBlocks('Before\n\n$$\nx\n$$\n\nAfter');
    expect(blocks.map((block) => block.html)).toEqual([
      '<p>Before</p>\n',
      '<div class="math math-block">x</div>\n',
      '<p>After</p>\n',
    ]);
  });
});

describe('math typesetting', () => {
  it('typesets placeholders with KaTeX in place', async () => {
    const host = render('Inline $x^2$\n\n$$\n\\frac{a}{b}\n$$');
    const block = host.querySelector('div.math-block')!;
    await enhanceMarkdown([...host.childNodes]);
    expect(host.querySelector('.math-inline .katex')).not.toBeNull();
    expect(host.querySelector('div.math-block .katex-display')).not.toBeNull();
    // The top-level node is changed in place, never replaced.
    expect(host.querySelector('div.math-block')).toBe(block);
  });

  it('does not let untrusted TeX add links or classes', async () => {
    const host = render('$\\href{https://example.com}{x}$ $\\htmlClass{modal-overlay}{y}$ $\\url{https://example.com}$');
    await enhanceMarkdown([...host.childNodes]);
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('.modal-overlay')).toBeNull();
  });

  it('renders invalid TeX as an inline error instead of throwing', async () => {
    const host = render('$\\frac{a$');
    await enhanceMarkdown([...host.childNodes]);
    expect(host.querySelector('.katex-error')).not.toBeNull();
  });

  it('typesets each placeholder once', async () => {
    const host = render('$x$');
    await enhanceMarkdown([...host.childNodes]);
    const first = host.querySelector('.katex');
    await enhanceMarkdown([...host.childNodes]);
    expect(host.querySelector('.katex')).toBe(first);
  });
});

describe('footnotes', () => {
  it('renders references and a footnote list with backlinks', () => {
    const host = render('Claim.[^1] Again.[^note]\n\n[^1]: First source.\n[^note]: Second **bold** source.');
    const refs = host.querySelectorAll('sup.footnote-ref a');
    expect(refs).toHaveLength(2);
    expect(refs[0].getAttribute('href')).toBe('#fn1');
    expect(host.querySelector('section.footnotes li#fn1')?.textContent).toContain('First source.');
    expect(host.querySelector('section.footnotes li#fn2 strong')?.textContent).toBe('bold');
    expect(host.querySelector('a.footnote-backref')?.getAttribute('href')).toBe('#fnref1');
  });

  it('keeps the footnote list as one trailing preview block', () => {
    const blocks = parseMarkdownBlocks('Text[^a]\n\n[^a]: Note');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].html).toContain('class="footnotes"');
  });

  it('leaves an undefined footnote reference as text', () => {
    expect(render('Missing[^x]').querySelector('.footnote-ref')).toBeNull();
  });
});
