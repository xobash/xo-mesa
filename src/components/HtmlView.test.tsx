// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  text: '<html><head><style>body{color:teal}</style></head><body><script>fetch("https://example.com/beacon")</script><img src="https://example.com/pixel"><p>Hello</p></body></html>',
  file: { path: '/vault/page.html', relPath: 'page.html', name: 'page', ext: 'html', isMarkdown: false, mtime: 1 },
  generation: 1,
  ensureContent: vi.fn(),
}));
vi.mock('../store', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ fileFor: () => mocks.file, vaultPath: '/vault', contentCache: { 'page.html': mocks.text }, getVaultGeneration: () => mocks.generation, ensureContent: mocks.ensureContent }) }));
vi.mock('../lib/confirmAction', () => ({ confirmAction: vi.fn() }));
vi.mock('../lib/vault', () => ({ IN_TAURI: false, urlForPath: (path: string) => `asset://localhost${path}` }));
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
