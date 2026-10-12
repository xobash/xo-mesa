// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { Overlay } from './components/Overlay';
import { Editor } from './components/Editor';
import { useAppStore } from './store';

vi.mock('./components/AgentPanel', () => ({ AgentSurface: () => null }));
vi.mock('./components/DeepResearchPanel', () => ({ DeepResearchPanel: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useAppStore.getState();
const host = document.createElement('div');
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 6, 8, 12));
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  useAppStore.setState(initial, true);
  localStorage.clear();
  vi.useRealTimers();
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
it.each([
  ['an ordinary day', new Date(2026, 6, 8, 12), '+1 more'],
  ['a public holiday', new Date(2026, 9, 12, 12), '+2 more'],
] as const)('keeps row semantics across year navigation, event actions and keyboard window movement on %s', async (_day, now, expectedMore) => {
  vi.setSystemTime(now);
  document.body.append(host);
  root = createRoot(host);
  localStorage.setItem('mesa:overlayToured', 'true');
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const openDaily = vi.fn(async () => {});
  const removeEvent = vi.fn(async () => {});
  const addEvent = vi.fn(async () => {});
  act(() => {
    useAppStore.setState({ overlayOpen: true, calendarEvents: Array.from({ length: 4 }, (_, i) => ({ date, title: `Event ${i}` })), openDailyNote: openDaily, removeCalendarEvent: removeEvent, addCalendarEvent: addEvent });
    root!.render(<Overlay />);
  });
  const click = (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
    expect(button, label).toBeDefined();
    act(() => button!.click());
  };
  if (!host.querySelector('.cal2')) click('Calendar window');
  expect(host.querySelector('.cal2-more')?.textContent).toBe(expectedMore);
  for (const view of ['Day', 'Week', 'Month', 'Year']) {
    click(view);
    const before = host.querySelector('.cal2-title')!.textContent;
    click('Next');
    expect(host.querySelector('.cal2-title')!.textContent).not.toBe(before);
    click('Previous');
    expect(host.querySelector('.cal2-title')!.textContent).toBe(before);
    click('Today');
  }
  expect(host.querySelectorAll('[role="grid"]')).toHaveLength(12);
  const results = await axe.run(host, { runOnly: ['aria-required-children', 'aria-required-parent', 'aria-input-field-name', 'link-in-text-block'] });
  expect(results.violations).toEqual([]);
  const mini = host.querySelector<HTMLButtonElement>('.mini [role="gridcell"]')!;
  const selectedDate = mini.dataset.calendarDate;
  act(() => mini.click());
  expect(host.querySelectorAll('[role="grid"]')).toHaveLength(1);
  expect(host.querySelector('[aria-selected="true"]')?.getAttribute('data-calendar-date')).toBe(selectedDate);
  click('Today');
  click('Week');
  const columns = [...host.querySelectorAll<HTMLDivElement>('.cal2-week-col')];
  act(() => columns[0].click());
  expect(columns[0].classList.contains('sel')).toBe(true);
  click('Year');
  click('January');
  expect(host.querySelectorAll('[role="grid"]')).toHaveLength(1);
  expect(host.querySelector('.cal2-title')?.textContent).toContain('January');
  click('Month'); click('Today');
  const eventInput = host.querySelector<HTMLInputElement>('.cal2-add input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(eventInput, 'New calendar event');
    eventInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector<HTMLButtonElement>('.cal2-add button')?.disabled).toBe(false);
  act(() => eventInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(addEvent).toHaveBeenCalledWith(date, 'New calendar event');
  expect(eventInput.value).toBe('');
  const remove = host.querySelector<HTMLButtonElement>('.cal-event-del')!;
  act(() => remove.click());
  expect(removeEvent).toHaveBeenCalledWith(date, 'Event 0');
  const bar = host.querySelector<HTMLElement>('[aria-label^="Calendar window."]')!;
  const floating = bar.closest<HTMLElement>('.ov-win')!;
  const originalLeft = parseFloat(floating.style.left);
  const originalWidth = parseFloat(floating.style.width);
  act(() => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(parseFloat(floating.style.left)).toBeGreaterThan(originalLeft);
  act(() => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })));
  expect(parseFloat(floating.style.width)).toBeGreaterThan(originalWidth);
  click('Close Calendar');
  expect(host.querySelector('.cal2')).toBeNull();
  click('Calendar window');
  click('Open note');
  expect(openDaily).toHaveBeenCalledWith(date);
  expect(useAppStore.getState().overlayOpen).toBe(false);
}, 15000);
