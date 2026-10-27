import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const linear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * linear((n >> 16 & 255) / 255) + 0.7152 * linear((n >> 8 & 255) / 255) + 0.0722 * linear((n & 255) / 255);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const palettes = new Map<string, Record<string, string>>();
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  for (const selector of block[1].split(',')) {
    const key = selector.trim();
    if (!/^:root\[data-theme="[^"]+"\](?:\[data-mode="[^"]+"\])?$/.test(key)) continue;
    const tokens = palettes.get(key) ?? {};
    for (const token of block[2].matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/gi)) tokens[token[1]] = token[2];
    palettes.set(key, tokens);
  }
}
it('covers all nine themes and both System modes', () => {
  expect(palettes.size).toBe(10);
  expect([...palettes.keys()].filter(key => key.includes('system'))).toHaveLength(2);
});
for (const [selector, tokens] of palettes) {
  it(`${selector} keeps faint text and eyebrows readable on each surface`, () => {
    expect(tokens['--text-faint']).not.toBe(tokens['--text-dim']);
    for (const foreground of ['--text-faint', '--eyebrow-color']) {
      for (const background of ['--bg', '--bg-1', '--bg-2']) {
        expect(contrast(tokens[foreground], tokens[background]), `${foreground} against ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}

for (const [selector, tokens] of palettes) {
  it(`${selector} keeps selected-control text readable`, () => {
    for (const background of ['--bg', '--bg-1', '--bg-2', '--bg-3']) {
      expect(contrast(tokens['--accent-text'], tokens[background])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens['--danger-contrast'], tokens['--danger'])).toBeGreaterThanOrEqual(4.5);
    // Selected palette/search rows show secondary text in --text-dim on --bg-3.
    expect(contrast(tokens['--text-dim'], tokens['--bg-3']), '--text-dim against --bg-3').toBeGreaterThanOrEqual(4.5);
  });
}

it('danger hover text uses the AA-checked contrast token instead of raw white', () => {
  const rule = css.match(/\.context-item\.danger:hover\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(rule).toContain('color: var(--danger-contrast)');
});
