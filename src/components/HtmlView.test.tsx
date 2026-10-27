// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  text: '<html><head><style>body{color:teal}</style></head><body><script>fetch("https://example.com/beacon")</script><img src="https://example.com/pixel"><p>Hello</p></body></html>',
  file: { path: '/vault/page.html', relPath: 'page.html', name: 'page', ext: 'html', isMarkdown: false, mtime: 1 },
  generation: 1,
  native: false,
  invoke: vi.fn(async (command: string) => command === "html_run_session" ? "test-token/page.html" : []),
  ensureContent: vi.fn(),
}));
vi.mock('../store', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ fileFor: () => mocks.file, vaultPath: '/vault', contentCache: { 'page.html': mocks.text }, getVaultGeneration: () => mocks.generation, ensureContent: mocks.ensureContent }) }));
vi.mock('../lib/confirmAction', () => ({ confirmAction: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (_path: string, protocol: string) => `${protocol}://localhost/` }));
vi.mock('../lib/vault', () => ({ get IN_TAURI() { return mocks.native; }, urlForPath: (path: string) => `asset://localhost${path}` }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn(async () => mocks.text), stat: async () => ({ size: mocks.text.length }) }));
import { confirmAction } from '../lib/confirmAction';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { HtmlView } from './HtmlView';
import * as htmlHelpers from '../lib/html';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const containers: { host: HTMLDivElement; root: ReturnType<typeof createRoot> }[] = [];
afterEach(async () => { for (const c of containers.splice(0)) { await act(async () => c.root.unmount()); c.host.remove(); } vi.restoreAllMocks(); });
it('opens offline, requires consent, and revokes active content on a new document version', async () => {
  mocks.generation = 1;
  mocks.ensureContent.mockImplementation(async () => mocks.text);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); containers.push({ host, root });
  await act(async () => root.render(<HtmlView rel="page.html" />));
  const frame = () => host.querySelector('iframe')!;
  expect(frame().getAttribute('sandbox')).toBe('');
  expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame().getAttribute('srcdoc')).toContain("connect-src 'none'");
  expect(frame().getAttribute('srcdoc')).not.toContain('<script');
  const confirm = vi.mocked(confirmAction).mockResolvedValue(false);
  await act(async () => (Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Enable online resources')!).click());
  expect(frame().getAttribute('sandbox')).toBe('');
  confirm.mockResolvedValue(true);
  await act(async () => (Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Enable online resources')!).click());
  expect(frame().getAttribute('sandbox')).toBe('');
  expect(frame().getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(frame().getAttribute('srcdoc')).not.toContain('<script');
  expect(frame().getAttribute('srcdoc')).toContain("script-src 'none'");
  expect(frame().getAttribute('srcdoc')).toContain('img-src data: blob: mesa-web:');
  mocks.generation++;
  await act(async () => root.render(<HtmlView rel="page.html" />));
  expect(frame().getAttribute('sandbox')).toBe('');
  expect(frame().getAttribute('srcdoc')).not.toContain('<script');
});
it('renders a detached file without relying on the main store catalog', async () => {
  const host = document.createElement('div'); const root = createRoot(host); containers.push({ host, root });
  await act(async () => root.render(<HtmlView rel="detached.html" file={{ ...mocks.file, relPath: 'detached.html', path: '/vault/detached.html' }} />));
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Hello');
  expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
});

it('refuses oversized detached HTML before reading or mounting a frame', async () => {
  vi.mocked(readTextFile).mockClear();
  const host = document.createElement('div'); const root = createRoot(host); containers.push({ host, root });
  await act(async () => root.render(<HtmlView rel="huge.html" file={{ ...mocks.file, size: 50 * 1024 * 1024 }} />));
  expect(readTextFile).not.toHaveBeenCalled();
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.textContent).toContain('too large to render');
});
it('a delayed consent cannot approve a changed document version', async () => {
  let finish: (value: boolean) => void = () => {};
  vi.mocked(confirmAction).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const host = document.createElement('div'); const root = createRoot(host); containers.push({ host, root });
  await act(async () => root.render(<HtmlView rel="page.html" />));
  await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Enable online resources')!.click());
  mocks.generation++;
  await act(async () => root.render(<HtmlView rel="page.html" />));
  await act(async () => finish(true));
  expect(host.textContent).toContain('Offline · scripts blocked');
});
it('waits for large-document hydration and sanitizes once across rerenders', async () => {
  const previous = mocks.text;
  mocks.text = `<p>${'large saved page '.repeat(170000)}</p>`;
  let finish: (value: string) => void = () => {};
  vi.spyOn(htmlHelpers, 'hydrateSavedHtml').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const sanitize = vi.spyOn(htmlHelpers, 'savedHtmlFrameDocument');
  const host = document.createElement('div'); const root = createRoot(host); containers.push({ host, root });
  try {
    await act(async () => root.render(<HtmlView rel="page.html" />));
    await act(async () => root.render(<HtmlView rel="page.html" />));
    expect(host.querySelector('iframe')).toBeNull();
    expect(sanitize).not.toHaveBeenCalled();
    await act(async () => finish('<p>Hydrated large page</p>'));
    const frame = host.querySelector('iframe');
    expect(frame?.getAttribute('srcdoc')).toContain('Hydrated large page');
    await act(async () => root.render(<HtmlView rel="page.html" />));
    expect(host.querySelector('iframe')).toBe(frame);
    expect(sanitize).toHaveBeenCalledTimes(1);
  } finally { mocks.text = previous; }
});

it('requires version-bound script/network consent and revokes stale and replaced sessions', async () => {
  mocks.native = true; mocks.invoke.mockClear();
  mocks.ensureContent.mockImplementation(async () => mocks.text);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); containers.push({ host, root });
  const click = async (label: string) => act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label)!.click());
  try {
    await act(async () => root.render(<HtmlView rel="page.html" />));
    vi.mocked(confirmAction).mockResolvedValue(false);
    await click('Run scripts'); expect(mocks.invoke).not.toHaveBeenCalledWith('html_run_session', expect.anything());
    vi.mocked(confirmAction).mockResolvedValue(true);
    await click('Run scripts');
    expect(mocks.invoke).toHaveBeenCalledWith('html_run_session', { path: mocks.file.path, online: false, expectedText: mocks.text });
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('mesa-html://localhost/test-token/page.html');
    expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(host.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false);
    expect(host.querySelector('iframe')?.getAttribute('allow')).toBe('');
    await click('Enable script network');
    expect(mocks.invoke).toHaveBeenCalledWith('html_run_revoke', { token: 'test-token' });
    expect(mocks.invoke).toHaveBeenCalledWith('html_run_session', { path: mocks.file.path, online: true, expectedText: mocks.text });
    expect(host.textContent).toContain('Scripts running · online');
    const originalFile = mocks.file;
    const sessionsBefore = mocks.invoke.mock.calls.filter(c => c[0] === 'html_run_session').length;
    mocks.file = { ...originalFile, path: '/vault/other.html', relPath: 'other.html' };
    await act(async () => root.render(<HtmlView rel="page.html" />));
    mocks.file = originalFile;
    await act(async () => root.render(<HtmlView rel="page.html" />));
    expect(host.textContent).toContain('Offline · scripts blocked');
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'html_run_session')).toHaveLength(sessionsBefore);
    mocks.generation++;
    await act(async () => root.render(<HtmlView rel="page.html" />));
    expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
    expect(host.textContent).toContain('Offline · scripts blocked');
    let answer: (value: boolean) => void = () => {};
    vi.mocked(confirmAction).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await click('Run scripts'); mocks.generation++;
    await act(async () => root.render(<HtmlView rel="page.html" />));
    const before = mocks.invoke.mock.calls.filter(c => c[0] === 'html_run_session').length;
    await act(async () => answer(true));
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'html_run_session')).toHaveLength(before);
    mocks.invoke.mockImplementationOnce(async () => { throw new Error('Script isolation unavailable'); });
    vi.mocked(confirmAction).mockResolvedValue(true);
    await click('Run scripts');
    expect(host.textContent).toContain('Script isolation unavailable');
    expect(host.textContent).toContain('Offline · scripts blocked');
    expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  } finally { mocks.native = false; }
});

it('shows a focusable, labelled Source view whose copy actions yield exact source text', async () => {
  const previous = mocks.text;
  mocks.text = `${'a'.repeat(400)}\r\n<p>${'b'.repeat(20)}</p>\n${'line\n'.repeat(3000)}end`;
  mocks.ensureContent.mockImplementation(async () => mocks.text);
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); containers.push({ host, root });
  const click = async (label: string) => act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label)!.click());
  const copy = () => {
    const data: Record<string, string> = {};
    const event = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { setData: (type: string, value: string) => { data[type] = value; } };
    scroller().dispatchEvent(event);
    return { prevented: event.defaultPrevented, text: data['text/plain'] };
  };
  const scroller = () => host.querySelector<HTMLElement>('.html-source')!;
  try {
    await act(async () => root.render(<HtmlView rel="page.html" />));
    await click('Source');
    expect(scroller().tabIndex).toBe(0);
    expect(scroller().getAttribute('role')).toBe('document');
    expect(scroller().getAttribute('aria-label')).toBe('Source of page');
    const rows = scroller().querySelectorAll('.html-source-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(3000);

    await click('Copy source');
    expect(writeText).toHaveBeenCalledWith(mocks.text);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Source copied.');

    // A selection across the wrapped rows of the first line keeps only its real CRLF line end.
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(rows[0].firstChild!, 10);
    range.setEnd(rows[3].firstChild!, 3);
    selection.addRange(range);
    expect(copy()).toEqual({ prevented: true, text: mocks.text.slice(10, mocks.text.indexOf('<p>') + 3) });

    // Select-all copies every row, including rows that are not mounted.
    await act(async () => { scroller().focus(); scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })); });
    expect(copy()).toEqual({ prevented: true, text: mocks.text });
  } finally { mocks.text = previous; vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges(); }
});
