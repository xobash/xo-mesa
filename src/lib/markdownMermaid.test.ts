// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { render, initialize } = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn() }));
vi.mock('mermaid', () => ({ default: { render, initialize } }));

import { parseMarkdown } from './markdownParser';
import { sanitizeHtml } from './markdown';
import { enhanceMarkdown, mermaidTheme } from './markdownEnhance';
import { sanitizeMermaidSvg } from './markdownMermaid';

const preview = (source: string) => {
  const host = document.createElement('div');
  host.innerHTML = sanitizeHtml(parseMarkdown(source));
  return host;
};

beforeEach(() => { render.mockReset(); initialize.mockReset(); });

describe('mermaid fences', () => {
  it('wraps mermaid fences in a stable block and leaves other fences alone', () => {
    const host = preview('```mermaid\ngraph TD; A-->B\n```\n\n```js\nx\n```');
    expect(host.querySelector('.mermaid-block > pre > code.language-mermaid')?.textContent).toBe('graph TD; A-->B\n');
    expect(host.querySelectorAll('.mermaid-block')).toHaveLength(1);
  });

  it('renders a sanitized diagram in place with strict security settings', async () => {
    render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" style="max-width: 120px;" viewBox="0 0 10 10"><g><text>A</text></g></svg>' });
    const host = preview('```mermaid\ngraph TD; A-->B\n```');
    const block = host.querySelector('.mermaid-block')!;
    await enhanceMarkdown([...host.childNodes]);
    expect(render).toHaveBeenCalledWith(expect.stringMatching(/^mesa-mermaid-\d+$/), 'graph TD; A-->B\n');
    const config = initialize.mock.calls[0][0];
    expect(config).toMatchObject({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
    expect(config.secure).toEqual(expect.arrayContaining(['securityLevel', 'themeCSS', 'htmlLabels']));
    const svg = block.querySelector('.mermaid-diagram svg')!;
    expect(svg.getAttribute('width')).toBe('120');
    expect(svg.hasAttribute('style')).toBe(false);
    expect(host.firstElementChild).toBe(block);
  });

  it('shows the error and keeps the source when rendering fails', async () => {
    render.mockRejectedValue(new Error('Parse error on line 1'));
    const host = preview('```mermaid\nnot a diagram\n```');
    await enhanceMarkdown([...host.childNodes]);
    expect(host.querySelector('.mermaid-error')?.textContent).toContain('Parse error on line 1');
    expect(host.querySelector('pre code')?.textContent).toBe('not a diagram\n');
  });

  it('uses the light palette only for light themes', () => {
    const root = document.createElement('html');
    root.dataset.theme = 'paper'; expect(mermaidTheme(root)).toBe('neutral');
    root.dataset.theme = 'system'; expect(mermaidTheme(root)).toBe('neutral');
    root.dataset.mode = 'dark'; expect(mermaidTheme(root)).toBe('dark');
    root.dataset.theme = 'midnight'; expect(mermaidTheme(root)).toBe('dark');
  });
});

describe('sanitizeMermaidSvg', () => {
  it('removes scripts, handlers, links, images, foreignObject and remote URLs', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<script>alert(1)</script><g onclick="alert(1)" onload="alert(2)"><rect fill="url(https://evil.example/x)" /></g>' +
      '<a href="javascript:alert(1)"><text>link</text></a><image href="https://evil.example/p.png" />' +
      '<foreignObject><div>html</div></foreignObject><use href="https://evil.example/s.svg#x" />' +
      '<path marker-end="url(#arrow)" /><style>@import url(https://evil.example/a.css);</style>' +
      '<animate attributeName="href" to="javascript:alert(1)" /></svg>');
    const host = document.createElement('div');
    host.innerHTML = clean;
    expect(host.querySelector('script, a, image, foreignObject, animate')).toBeNull();
    expect(host.querySelector('[onclick], [onload]')).toBeNull();
    expect(host.querySelector('rect')?.hasAttribute('fill')).toBe(false);
    expect(host.querySelector('use[href], [*|href]:not([href^="#"])')).toBeNull();
    expect(host.querySelector('path')?.getAttribute('marker-end')).toBe('url(#arrow)');
    expect(host.querySelector('style')).toBeNull();
    expect(clean).not.toContain('evil.example');
  });

  it('keeps Mermaid-scoped styles', () => {
    const clean = sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" id="m1"><style>#m1 .node rect{fill:#333;}</style><g class="node"><rect /></g></svg>');
    expect(clean).toContain('#m1 .node rect');
  });

  it('drops style rules that reach outside the diagram', () => {
    // A classDef value that closes its rule early must not restyle the app.
    const clean = sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" id="m1"><style>' +
      '#m1 .a{fill:red;} body{display:none;} #m10 .b{fill:blue;} #m1 .c, .modal-overlay{opacity:0;} ' +
      '@media screen{#m1 .d{fill:green;}} #m1 .e{background:image-set("https://evil.example/x.png" 1x);}' +
      '</style><g /></svg>');
    expect(clean).toContain('#m1 .a');
    for (const text of ['body', '#m10', 'modal-overlay', '@media', 'evil.example']) expect(clean).not.toContain(text);
  });

  it('returns nothing for markup that is not an SVG', () => {
    expect(sanitizeMermaidSvg('<div>no</div>')).toBe('');
  });
});
