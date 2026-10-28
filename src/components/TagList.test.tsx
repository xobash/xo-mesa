// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ state: {} as Record<string, unknown>, enter: vi.fn(), leave: vi.fn() }));
vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select(io.state) }));
vi.mock('./previewTriggers', () => ({ previewEnter: io.enter, previewLeave: io.leave }));
import { TagList } from './TagList';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const render = () => act(async () => root.render(<TagList />));
beforeEach(() => {
  io.state = {
    notes: { a: { tags: ['beta', 'alpha'] }, b: { tags: ['beta'] }, c: { tags: ['gamma'] } },
    openSearch: vi.fn(), setSetting: vi.fn(), settings: { tagsCollapsed: false },
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it('orders tags by count then name and searches the chosen tag', async () => {
  await render();
  const chips = [...host.querySelectorAll('.tag-chip')];
  expect(chips.map((c) => c.textContent)).toEqual(['#beta2', '#alpha1', '#gamma1']);
  expect(host.querySelector('.tag-section-count')!.textContent).toBe('3');
  chips[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  expect(io.enter).toHaveBeenCalledWith({ kind: 'tag', tag: 'beta' }, expect.anything());
  await act(async () => (chips[0] as HTMLButtonElement).click());
  expect(io.leave).toHaveBeenCalled();
  expect(io.state.openSearch).toHaveBeenCalledWith('#beta');
});

it('collapses through the persisted setting and renders nothing without tags', async () => {
  io.state.settings = { tagsCollapsed: true };
  await render();
  const header = host.querySelector('.tag-header') as HTMLButtonElement;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.tag-chip')).toBeNull();
  await act(async () => header.click());
  expect(io.state.setSetting).toHaveBeenCalledWith('tagsCollapsed', false);
  io.state.notes = { a: { tags: [] } };
  await render();
  expect(host.innerHTML).toBe('');
});
