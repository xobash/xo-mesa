// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { Overlay } from './components/Overlay';
import { Editor } from './components/Editor';
import { useAppStore } from './store';

vi.mock('./components/AgentSurface', () => ({ AgentSurface: () => null }));
vi.mock('./components/DeepResearchPanel', () => ({ DeepResearchPanel: () => null }));
vi.mock('./components/OverlayGallery', () => ({ OverlayGallery: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useAppStore.getState();
const host = document.createElement('div');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  useAppStore.setState(initial, true);
  localStorage.clear();
});
it('names the editor and retains calendar rows and keyboard date navigation', async () => {
  document.body.append(host);
  root = createRoot(host);
  localStorage.setItem('mesa:overlayToured', 'true');
  act(() => {
    useAppStore.setState({ overlayOpen: true, activePath: 'a.md', activeContentState: 'ready', content: 'Hello', contentCache: { 'a.md': 'Hello' } });
    root!.render(<><Editor /><Overlay /></>);
  });
  const calendar = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === 'Calendar window');
  expect(calendar).toBeDefined();
  if (!host.querySelector('[role="grid"]')) act(() => calendar!.click());
  const grid = host.querySelector('[role="grid"]')!;
  expect(grid).not.toBeNull();
  expect(grid.querySelectorAll(':scope > [role="row"]').length).toBeGreaterThan(4);
  expect(host.querySelector('.cm-content')?.getAttribute('aria-label')).toBe('Note editor');
  const selected = grid.querySelector<HTMLButtonElement>('[role="gridcell"][aria-selected="true"]')!;
  const date = selected.dataset.calendarDate!;
  act(() => selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(grid.querySelector('[aria-selected="true"]')?.getAttribute('data-calendar-date')).not.toBe(date);
  const results = await axe.run(host, { runOnly: ['aria-required-children', 'aria-required-parent', 'aria-input-field-name', 'link-in-text-block'] });
  expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
