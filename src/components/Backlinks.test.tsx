// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select(io.state) }));
vi.mock('../lib/graph', () => ({ backlinksFor: (_notes: unknown, id: string) => (id === 'Hub.md' ? ['A.md', 'Gone.md'] : []) }));
import { Backlinks } from './Backlinks';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const render = () => act(async () => root.render(<Backlinks />));
beforeEach(() => {
  io.state = { notes: { 'A.md': { title: 'Alpha' } }, activePath: 'Hub.md', selectFile: vi.fn(async () => {}), indexingTextFiles: 0 };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('lists linking notes by title and opens one', async () => {
  await render();
  const links = [...host.querySelectorAll('.backlink')] as HTMLButtonElement[];
  expect(links.map((l) => l.textContent)).toEqual(['Alpha', 'Gone.md']);
  expect(host.querySelector('.count')!.textContent).toBe('2');
  await act(async () => links[0].click());
  expect(io.state.selectFile).toHaveBeenCalledWith('A.md');
});

it('discloses incomplete indexing and the empty state', async () => {
  io.state.activePath = 'Lonely.md'; io.state.indexingTextFiles = 12;
  await render();
  expect(host.querySelector('[role="status"]')!.textContent).toBe('Indexing 12 text files; links may grow.');
  expect(host.textContent).toContain('No notes link here yet.');
  io.state.activePath = null;
  await render();
  expect(host.innerHTML).toBe('');
});
