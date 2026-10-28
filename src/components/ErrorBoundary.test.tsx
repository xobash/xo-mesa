// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
let broken = true;
function Child() { if (broken) throw new Error('render exploded'); return <p>Recovered view</p>; }
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('replaces a crashed tree with a recoverable panel and can dismiss it', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ErrorBoundary><Child /></ErrorBoundary>));
  expect(host.querySelector('h1')!.textContent).toBe('Something went wrong');
  expect(host.querySelector('.crash-detail')!.textContent).toContain('render exploded');
  expect(log).toHaveBeenCalledWith('Mesa crashed:', expect.any(Error), expect.anything());
  broken = false;
  const dismiss = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!;
  await act(async () => dismiss.click());
  expect(host.textContent).toBe('Recovered view');
});
