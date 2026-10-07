// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildReaderHtml, READER_BRIDGE, READER_SCRIPT_HASH } from './browserReader';
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
