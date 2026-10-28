// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

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

it('online resources never authorize executable saved markup', async () => {
  const { savedHtmlFrameDocument } = await import('./html');
  const result = savedHtmlFrameDocument('<script>fetch("https://example.com")</script><p onclick="bad()">Hello</p><form action="https://example.com"></form><img src="https://example.com/pixel">', true);
  expect(result).toContain("script-src 'none'");
  expect(result).toContain("connect-src 'none'");
  expect(result).toContain('https://example.com/pixel');
  for (const unsafe of ['<script', 'onclick=', '<form']) expect(result).not.toContain(unsafe);
});

it('retains native asset images and local SVG sprites, and rejects executable or external references', async () => {
  const { savedHtmlFrameDocument } = await import('./html');
  const html = savedHtmlFrameDocument('<img src="asset://localhost/%2Fv%2Fa.png"><img src="javascript:bad()"><svg><symbol id="i"></symbol><use href="#i"></use><use href="https://example.com/i.svg#i"></use></svg>');
  expect(html).toContain('src="asset://localhost/%2Fv%2Fa.png"');
  expect(html).toContain('href="#i"');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('https://example.com/i.svg');
});

it('desktop confirmations await the message-based dialog and fail closed on rejection', async () => {
  vi.resetModules();
  vi.doMock('./vault', () => ({ IN_TAURI: true }));
  let answer: (value: boolean) => void = () => {};
  const dialog = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; }));
  vi.doMock('@tauri-apps/plugin-dialog', () => ({ confirm: dialog }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { confirmAction } = await import('./confirmAction');
    let settled = false;
    const pending = confirmAction('Discard?', { okLabel: 'Discard' }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(dialog).toHaveBeenCalled());
    expect(settled).toBe(false);
    answer(false);
    expect(await pending).toBe(false);
    dialog.mockRejectedValueOnce(new Error('dialog unavailable'));
    expect(await confirmAction('Discard?')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    vi.doUnmock('./vault'); vi.doUnmock('@tauri-apps/plugin-dialog'); warn.mockRestore(); vi.resetModules();
  }
});

it('retains stylesheets containing inert SVG data images without weakening sanitization', async () => {
  const { hydrateSavedHtml, savedHtmlFrameDocument } = await import('./html');
  const html = await hydrateSavedHtml(`<style>body{color:teal}.icon{background:url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')}</style><p>Kept</p>`, '/vault/page.html', path => `asset://localhost${path}`, async () => '', { scripts: false });
  const frame = savedHtmlFrameDocument(html);
  expect(frame).toContain('body{color:teal}');
  expect(frame).toContain('%3Csvg');
  expect(frame).not.toContain('<svg xmlns=');
});

it('preview stripping leaves no parsed script or handler in obfuscated markup', async () => {
  const { stripSavedHtmlPreviewCode } = await import('./html');
  const inputs = [
    '<scr<script>x</script>ipt>alert(1)</script>',
    '<<script></script>script>alert(1)</script>',
    '<img src=x onerror=a()//><p/onclick=b()>c</p><a x="1"onclick="2">d</a>',
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<SCRIPT\n>a()</SCRIPT\n><script >b()</script foo>',
    '<img a="1" o onx="2"nerror=3>',
  ];
  for (const input of inputs) {
    const doc = new DOMParser().parseFromString(stripSavedHtmlPreviewCode(input), 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    for (const element of doc.querySelectorAll('*')) {
      expect(element.getAttributeNames().filter(name => name.startsWith('on'))).toEqual([]);
    }
  }
});

it('removes external SVG xlink references while keeping same-document sprites', async () => {
  const { savedHtmlFrameDocument } = await import('./html');
  const html = savedHtmlFrameDocument('<svg><symbol id="i"></symbol><use xlink:href="#i"></use><a xlink:href="https://example.com/out"><text>t</text></a><image xlink:href="https://example.com/p.png"></image></svg>');
  expect(html).toContain('xlink:href="#i"');
  expect(html).not.toContain('https://example.com');
});
