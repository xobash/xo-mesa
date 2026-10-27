import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const declarations = (selector: string) => {
  const result: Record<string, string> = {};
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!block[1].split(',').some(part => part.trim() === selector)) continue;
    for (const decl of block[2].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) result[decl[1]] = decl[2].trim();
  }
  return result;
};

it('keeps the windowed HTML source sized by its host in block-level detached windows', () => {
  // Size containment collapses the scroller to its padding inside a block host.
  expect(declarations('.html-source').contain ?? '').not.toMatch(/\b(strict|size|inline-size)\b/);
  expect(declarations('.html-source')['flex']).toBe('1 1 auto');
  // The detached and popout body is a block container, so the HTML view needs an explicit bounded height.
  expect(declarations('.doc-window-body').overflow ?? declarations('.doc-window-body')['overflow-y']).toBe('auto');
  expect(declarations('.doc-window-body > .html-view').height).toBe('100%');
  expect(declarations('.html-view')).toMatchObject({ display: 'flex', 'flex-direction': 'column', 'min-height': '0' });
});
