// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { VaultImage } from './VaultImage';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
async function render(src: string) {
  await act(async () => { root.render(<VaultImage src={src} alt="Blue Marble" />); });
}
const fail = () => act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
const retry = () => host.querySelector('button') as HTMLButtonElement;
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('keeps the source unchanged, reports failure locally and retries the same source', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render('asset://vault/blue.png');
  expect(host.querySelector('img')!.getAttribute('src')).toBe('asset://vault/blue.png');
  await fail();
  expect(host.querySelector('[role="status"]')!.textContent).toContain('Cannot load image: Blue Marble.');
  expect(host.querySelector('img')).toBeNull();
  await act(async () => retry().click());
  expect(host.querySelector('img')!.getAttribute('src')).toBe('asset://vault/blue.png');
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('moves focus to the new Retry button only when a keyboard retry fails again', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render('asset://vault/a.png');
  await fail();
  retry().focus();
  await act(async () => retry().click());
  await fail();
  expect(document.activeElement).toBe(retry());
  // A pointer retry (focus elsewhere) does not steal focus on the next failure.
  (document.activeElement as HTMLElement).blur();
  await act(async () => retry().click());
  await fail();
  expect(document.activeElement).not.toBe(retry());
});

it('resets the failure state when the source changes', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render('asset://vault/a.png');
  await fail();
  await render('asset://vault/b.png');
  expect(host.querySelector('img')!.getAttribute('src')).toBe('asset://vault/b.png');
  expect(host.querySelector('[role="status"]')).toBeNull();
});
