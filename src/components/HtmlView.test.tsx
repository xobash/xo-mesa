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
vi.mock('../lib/vault', () => ({ urlForPath: (path: string) => `asset://localhost${path}` }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: async () => mocks.text }));
import { HtmlView } from './HtmlView';
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
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => (Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Enable active content')!).click());
  expect(frame().getAttribute('sandbox')).toBe('');
  confirm.mockReturnValue(true);
  await act(async () => (Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Enable active content')!).click());
  expect(frame().getAttribute('sandbox')).toContain('allow-scripts');
  expect(frame().getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(frame().getAttribute('srcdoc')).toContain('<script');
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
