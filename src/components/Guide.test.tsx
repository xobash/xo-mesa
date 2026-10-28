// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select(io.state) }));
vi.mock('./Modal', () => ({ Modal: ({ children, title }: { children: React.ReactNode; title: string }) => <div role="dialog" aria-label={title}>{children}</div> }));
import { HelpModal, Tour, hasToured } from './Guide';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
const title = () => host.querySelector('.guide-title')?.textContent;
beforeEach(() => {
  localStorage.clear();
  io.state = { tourOpen: true, setTourOpen: vi.fn(), helpOpen: true, setHelpOpen: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('steps through the tour and records completion', async () => {
  await act(async () => root.render(<Tour />));
  expect(title()).toBe('Your vault workspace');
  expect(button('Back')).toBeUndefined();
  await act(async () => button('Next')!.click());
  expect(title()).toBe('Write and connect');
  await act(async () => button('Back')!.click());
  expect(title()).toBe('Your vault workspace');
  for (let i = 0; i < 4; i++) await act(async () => button('Next')!.click());
  expect(title()).toBe('Overlay, Pi, and sync');
  expect(button('Next')).toBeUndefined();
  expect(hasToured()).toBe(false);
  await act(async () => button('Start writing')!.click());
  expect(io.state.setTourOpen).toHaveBeenCalledWith(false);
  expect(hasToured()).toBe(true);
});

it('Skip also records completion; closed tour renders nothing', async () => {
  await act(async () => root.render(<Tour />));
  await act(async () => button('Skip')!.click());
  expect(hasToured()).toBe(true);
  io.state.tourOpen = false;
  await act(async () => root.render(<Tour />));
  expect(host.innerHTML).toBe('');
});

it('Help lists every step and closes through its header', async () => {
  await act(async () => root.render(<HelpModal />));
  expect(host.querySelectorAll('.guide-list-item')).toHaveLength(5);
  await act(async () => button('Close')!.click());
  expect(io.state.setHelpOpen).toHaveBeenCalledWith(false);
});
