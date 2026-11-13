import { readFileSync } from 'node:fs';
import { readStylesheet } from '../styles/source';
import { expect, it } from 'vitest';

const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
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

it('gives every monospace stack a Windows font before the generic family', () => {
  // Without one, Windows falls back to Courier New in Deep Research and code views.
  const stacks = [...css.matchAll(/font(?:-family)?\s*:[^;{}]*\bmonospace\b[^;{}]*/g)].map((match) => match[0]);
  expect(stacks.length).toBeGreaterThan(0);
  for (const stack of stacks) expect(stack, stack).toMatch(/Consolas|var\(--mono\)/);
});

it('defines every custom property that a stylesheet reads without a fallback', () => {
  // An undefined var() without a fallback invalidates the whole declaration at computed time.
  const trayCss = readFileSync(new URL('../tray/tray.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const undefinedReads = (sheet: string) => {
    const defined = new Set([...sheet.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    const read = [...sheet.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1]);
    return [...new Set(read.filter((name) => !defined.has(name)))].sort();
  };
  expect(undefinedReads(css)).toEqual([]);
  expect(undefinedReads(trayCss)).toEqual([]);
});
