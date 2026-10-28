// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildReaderDocument, buildReaderHtml, prepareReaderResources, READER_BRIDGE, READER_SCRIPT_HASH } from './browserReader';
import config from '../../src-tauri/tauri.conf.json';

describe('brokered browser document', () => {
  it('admits exactly the navigation bridge by its real script hash', async () => {
    // Node-only hashing checks the shipped bridge without adding Node globals to frontend types.
    const cryptoModule = 'node:crypto';
    const { createHash } = await import(/* @vite-ignore */ cryptoModule);
    const script = READER_BRIDGE.slice('<script>'.length, -'</script>'.length);
    expect(READER_SCRIPT_HASH).toBe(`sha256-${createHash('sha256').update(script).digest('base64')}`);
    expect(config.app.security.csp).toContain(`'${READER_SCRIPT_HASH}'`);
    expect(config.app.security.csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('blocks executable content, refreshes, nested frames and every network subresource', () => {
    const result = buildReaderHtml(`<meta http-equiv="refresh" content="0;url=https://example.org"><base href="https://example.org"><script>fetch('http://localhost')</script><iframe src="https://example.org"></iframe><form action="https://example.org"><input></form><p onclick="bad()">Read me</p><a href="/next" ping="https://example.org">Next</a><img src="https://example.org/pixel"><style>body{background:url(https://example.org/pixel)}</style>`, 'https://example.com/start');
    const doc = new DOMParser().parseFromString(result, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('script')?.textContent).toBe(READER_BRIDGE.slice(8, -9));
    expect(doc.querySelectorAll('base')).toHaveLength(0);
    expect(doc.querySelectorAll('iframe,form,[onclick],[ping]')).toHaveLength(0);
    const policy = doc.querySelector('meta[http-equiv]')!.getAttribute('content');
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("img-src data:");
    expect(policy).toContain("default-src 'none'");
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/next');
    expect(doc.body.textContent).toContain('Read me');
  });

  it('resolves links against the broker URL without relaxing the inherited base policy', () => {
    expect(() => buildReaderHtml('<p>Hi</p>', 'javascript:bad()')).toThrow();
    const result = buildReaderHtml('<base href="https://example.org"><a href="?a=1&b=%22">Next</a><a href="mailto:x@example.com">Mail</a>', 'https://example.com/start');
    const doc = new DOMParser().parseFromString(result, 'text/html');
    expect(doc.querySelectorAll('base')).toHaveLength(0);
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/start?a=1&b=%22');
    expect(doc.querySelectorAll('a[href]')).toHaveLength(1);
    expect(result).toContain("base-uri 'none'");
  });
});

it('proxies lazy images, imported CSS and fonts while retaining script isolation', async () => {
  const urls: string[] = [];
  const result = await buildReaderDocument('<base href="https://example.com/articles/"><link rel="stylesheet" href="../main.css"><img data-src="img/a.png"><script>bad()</script>', 'https://example.com/start', {
    token: 'test', proxyBase: 'mesa-web://localhost/', fetchStylesheet: async url => {
      urls.push(url);
      return url.endsWith('main.css') ? '@import "fonts.css";p{background:url(bg.png)}' : '@font-face{font-family:x;src:url(font.woff2)}';
    }
  });
  expect(urls).toEqual(['https://example.com/main.css', 'https://example.com/fonts.css']);
  expect(result).toContain('mesa-web://localhost/test?u=https%3A%2F%2Fexample.com%2Farticles%2Fimg%2Fa.png');
  expect(result).toContain('font.woff2');
  expect(result).not.toContain('bad()');
  expect(result).not.toContain('<link');
  expect(result).toContain("connect-src 'none'");
  expect(result).toContain("font-src data: mesa-web:");
});

it('resolves CSS assets against the final stylesheet URL after redirects', async () => {
  const result = await buildReaderDocument('<link rel="stylesheet" href="/redirect.css">', 'https://example.com/', {
    token: 'test', proxyBase: 'mesa-web://localhost/', fetchStylesheet: async () => ({ css: 'p{background:url(image.png)}', finalUrl: 'https://example.org/assets/style.css' })
  });
  expect(result).toContain('https%3A%2F%2Fexample.org%2Fassets%2Fimage.png');
});

it('saved online preparation preserves local media while dropping remote audio/video', async () => {
  const html = await prepareReaderResources('<video src="asset://localhost/vault/movie.mp4" poster="asset://localhost/vault/poster.png"></video><audio src="https://example.com/audio.mp3"></audio>', 'https://example.com/', {
    token: 'test', proxyBase: 'mesa-web://localhost/', allowLocal: true, fetchStylesheet: async () => ''
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(doc.querySelector('video')?.getAttribute('src')).toBe('asset://localhost/vault/movie.mp4');
  expect(doc.querySelector('video')?.getAttribute('poster')).toBe('asset://localhost/vault/poster.png');
  expect(doc.querySelector('audio')?.hasAttribute('src')).toBe(false);
});

it('retains brokered CSS containing SVG data URLs', async () => {
  const html = await buildReaderDocument('<link rel="stylesheet" href="/style.css">', 'https://example.com/', {
    token: 'test', proxyBase: 'mesa-web://localhost/', fetchStylesheet: async () => `body{color:teal}.icon{background:url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>')}`
  });
  expect(html).toContain('body{color:teal}');
  expect(html).toContain('%3Csvg');
});

it('brokers each srcset candidate whole when CDN URLs contain commas', async () => {
  const html = await prepareReaderResources('<img srcset="https://cdn.example/c_fill,w_100/a.png 1x, https://cdn.example/c_fill,w_200/a.png 2x">', 'https://example.com/', {
    token: 't', proxyBase: 'mesa-web://localhost/', fetchStylesheet: async () => ''
  });
  const srcset = new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('srcset');
  expect(srcset).toBe(`mesa-web://localhost/t?u=${encodeURIComponent('https://cdn.example/c_fill,w_100/a.png')} 1x, mesa-web://localhost/t?u=${encodeURIComponent('https://cdn.example/c_fill,w_200/a.png')} 2x`);
});

it('prepares hostile stylesheet text in linear time', async () => {
  const sheets = ['url(a'.repeat(40_000), `url(a${' '.repeat(200_000)}`, '@import a'.repeat(22_000)];
  for (const css of sheets) {
    const start = performance.now();
    const html = await prepareReaderResources('<link rel="stylesheet" href="/s.css">', 'https://example.com/', {
      token: 't', proxyBase: 'mesa-web://localhost/', fetchStylesheet: async () => css
    });
    // Measured in milliseconds; the bound separates linear from quadratic work.
    expect(performance.now() - start).toBeLessThan(200);
    expect(html).toContain('<style>');
  }
  const unterminated = await prepareReaderResources('<style>p{background:url(a.png)} @import "x.css"</style>', 'https://example.com/', {
    token: 't', proxyBase: 'mesa-web://localhost/', fetchStylesheet: async () => { throw new Error('not requested'); }
  });
  expect(unterminated).toContain(`url("mesa-web://localhost/t?u=${encodeURIComponent('https://example.com/a.png')}")`);
  expect(unterminated).toContain('@import "x.css"');
});
