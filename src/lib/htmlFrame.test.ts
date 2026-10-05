// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

describe('offline frame policy', () => {
  it('places the policy before hostile metadata and strips navigation and executable content', async () => {
    const { savedHtmlFrameDocument } = await import('./html');
    const html = savedHtmlFrameDocument('<meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><script>bad()</script><iframe src="https://example.com"></iframe><a href="https://example.com" ping="https://example.com">link</a><style>p{color:red}</style><p onclick="bad()">Safe</p>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('Safe'));
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain('p{color:red}');
    for (const hostile of ['http-equiv="refresh"', '<base', '<script', '<iframe', 'onclick=', 'href=', 'ping=']) expect(html).not.toContain(hostile);
  });
});
