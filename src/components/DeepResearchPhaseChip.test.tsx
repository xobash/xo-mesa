// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeepResearchRunState } from '../store';

vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select({ deepResearch: null }) }));
import { DeepResearchPhaseChip, DeepResearchPhaseChipWithRun } from './DeepResearchPhaseChip';

const notes = Array.from({ length: 10 }, (_, i) => ({ relPath: `Note ${i}.md`, via: ['linked'] }));
const run = (patch: Partial<DeepResearchRunState> = {}) => ({
  runId: 'r1', phase: 'researching', launchStage: 'running', piTurnEnded: false, finishRejection: null,
  context: { query: 'q', scope: 'workspace', notes, totalBytes: 1, truncated: true, omittedNotes: 1, summary: '10 notes' },
  ...patch,
}) as unknown as DeepResearchRunState;

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const render = (value: DeepResearchRunState | null) => act(async () => root.render(<DeepResearchPhaseChipWithRun runOverride={value} />));
const chip = () => host.querySelector('button.dr-phase') as HTMLButtonElement;
const popover = () => document.body.querySelector('.dr-context-popover');
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('renders nothing without a run', async () => {
  await act(async () => root.render(<DeepResearchPhaseChip />));
  expect(host.innerHTML).toBe('');
});

it.each([
  [{ phase: 'planning', launchStage: 'starting-pi' }, 'Starting Pi…'],
  [{ phase: 'planning' }, 'Planning sub-questions…'],
  [{ phase: 'researching', launchStage: 'waiting-for-model' }, 'Waiting for Pi…'],
  [{ phase: 'synthesizing' }, 'Drafting report…'],
  [{ phase: 'synthesizing', piTurnEnded: true }, 'Pi turn ended — report not accepted'],
  [{ phase: 'researching', finishRejection: { reason: 'x' } }, 'Correcting rejected report…'],
  [{ phase: 'review' }, 'Review proposed changes'],
  [{ phase: 'done', context: null }, 'Done'],
] as const)('labels %o as %s', async (patch, label) => {
  await render(run(patch as Partial<DeepResearchRunState>));
  expect(chip().textContent).toContain(label);
});

it('shows context on hover, pins it on click and closes on Escape', async () => {
  await render(run());
  expect(chip().getAttribute('aria-label')).toBe('Researching sources…. Show Context sent to Pi.');
  host.querySelector('.dr-phase-context')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await act(async () => {});
  expect(popover()!.textContent).toContain('10 notes · workspace scope');
  expect(popover()!.textContent).toContain('+2 more');
  expect(popover()!.textContent).toContain('1 related note omitted.');
  host.querySelector('.dr-phase-context')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(popover()).toBeNull();

  await act(async () => chip().click());
  expect(chip().getAttribute('aria-expanded')).toBe('true');
  host.querySelector('.dr-phase-context')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(popover()).not.toBeNull();
  await act(async () => chip().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(popover()).toBeNull();
});

it('unpins when a new run starts', async () => {
  await render(run());
  await act(async () => chip().click());
  expect(popover()).not.toBeNull();
  await render(run({ runId: 'r2' }));
  expect(popover()).toBeNull();
});
