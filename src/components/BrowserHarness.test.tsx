// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ invoke: vi.fn(), state: { vaultPath: '/vault', openVault: vi.fn(), openFile: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
vi.mock('../lib/vault', () => ({ IN_TAURI: true, writeVaultTextFile: vi.fn() }));
vi.mock('../store', () => ({ useAppStore: Object.assign((fn: (s: unknown) => unknown) => fn(mock.state), { getState: () => mock.state }) }));
import { BrowserHarness } from './BrowserHarness';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function mount() {
  mock.invoke.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<BrowserHarness />));
}
async function navigate(url: string) {
  await act(async () => root.render(<BrowserHarness externalNav={{ url, seq: Date.now() + Math.random() }} />));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });
const page = (url: string, body: string) => ({ finalUrl: url, body, contentType: 'text/html', status: 200, frameBlocked: false });
it('always reads through the broker and never navigates a webview to the approved hostname', async () => {
  await mount(); mock.invoke.mockResolvedValue(page('https://example.com', '<script>bad()</script><p>Safe page</p>'));
  await navigate('https://example.com');
  expect(mock.invoke.mock.calls.map(c => c[0])).toEqual(['browse_fetch']);
  const frame = host.querySelector('iframe')!;
  expect(frame.hasAttribute('src')).toBe(false);
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('srcdoc')).not.toContain('bad()');
  expect(frame.getAttribute('srcdoc')).toContain('Safe page');
});
it('keeps a rejected destination out of every iframe', async () => {
  await mount(); mock.invoke.mockRejectedValue(new Error('private network address is blocked'));
  await navigate('https://example.com');
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('private network');
});
it('drops an older response after a newer navigation', async () => {
  await mount(); let finish: (value: unknown) => void = () => {};
  mock.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await navigate('https://example.com/old');
  mock.invoke.mockResolvedValue(page('https://example.com/new', '<p>New page</p>'));
  await navigate('https://example.com/new');
  await act(async () => finish(page('https://example.com/old', '<p>Old page</p>')));
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('New page');
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('Old page');
});
it('retains back and forward navigation through the broker', async () => {
  await mount(); mock.invoke.mockImplementation((_command, args) => Promise.resolve(page(args.url, '<p>Page</p>')));
  await navigate('https://example.com/one'); await navigate('https://example.com/two');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label=Back]')!.click());
  expect(mock.invoke.mock.lastCall?.[1].url).toBe('https://example.com/one');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label=Forward]')!.click());
  expect(mock.invoke.mock.lastCall?.[1].url).toBe('https://example.com/two');
});

it('registers one message listener and uses current history after rerenders', async () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  await mount();
  mock.invoke.mockImplementation((_command, args) => Promise.resolve(page(args.url, '<p>Page</p>')));
  await navigate('https://example.com/one');
  await navigate('https://example.com/two');
  const frame = host.querySelector('iframe')!;
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, data: { __mesaBrowse: { url: 'https://example.com/three' } },
  })));
  expect(mock.invoke.mock.lastCall?.[1].url).toBe('https://example.com/three');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label=Back]')!.click());
  expect(mock.invoke.mock.lastCall?.[1].url).toBe('https://example.com/two');
  const listeners = add.mock.calls.filter(([type]) => type === 'message');
  expect(listeners).toHaveLength(1);
  await act(async () => root.unmount());
  expect(remove.mock.calls.filter(([type]) => type === 'message')).toEqual([['message', listeners[0][1]]]);
  add.mockRestore(); remove.mockRestore();
});

it('shows the direct-connection guidance returned by the broker', async () => {
  await mount();
  mock.invoke.mockRejectedValue('Direct connection failed. Mesa does not use system proxies. Check your connection.');
  await navigate('https://example.com');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Mesa does not use system proxies');
  expect(host.querySelector('iframe')).toBeNull();
});
