// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeepResearchRunState } from './store';
const io = vi.hoisted(() => ({ confirm: vi.fn(async (_message: string, _options?: unknown) => false) }));
vi.mock('./lib/confirmAction', () => ({ confirmAction: io.confirm }));
import { useAppStore } from './store';
const initial = useAppStore.getState();
const store = () => useAppStore.getState();
const op = { relPath: 'Research/Report.md', content: '# Report' };
function run(patch: Partial<DeepResearchRunState>): DeepResearchRunState {
  return { runId: 'r1', phase: 'review', changeSet: { reportRelPath: op.relPath, ops: [op] }, ...patch } as unknown as DeepResearchRunState;
}
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(initial, true);
});

it('asks before discarding an unapplied proposal and keeps it on Cancel', async () => {
  useAppStore.setState({ deepResearch: run({}) });
  expect(await store().requestDiscardDeepResearch()).toBe(false);
  expect(io.confirm).toHaveBeenCalledOnce();
  expect(io.confirm.mock.calls[0][0]).toContain('1 proposed change');
  expect(store().deepResearch?.runId).toBe('r1');

  io.confirm.mockResolvedValueOnce(true);
  expect(await store().requestDiscardDeepResearch()).toBe(true);
  expect(store().deepResearch).toBeNull();
});

it('keeps a proposal that failed to apply until the user confirms', async () => {
  useAppStore.setState({ deepResearch: run({ phase: 'error' }) });
  expect(await store().requestDiscardDeepResearch()).toBe(false);
  expect(store().deepResearch).not.toBeNull();
});

it('does not discard a newer run that replaced the one in the dialog', async () => {
  useAppStore.setState({ deepResearch: run({}) });
  io.confirm.mockImplementationOnce(async () => {
    useAppStore.setState({ deepResearch: run({ runId: 'r2' }) });
    return true;
  });
  expect(await store().requestDiscardDeepResearch()).toBe(false);
  expect(store().deepResearch?.runId).toBe('r2');
});

it('closes without asking when nothing unapplied would be lost', async () => {
  for (const patch of [{ phase: 'done' as const }, { phase: 'error' as const, changeSet: null }, { phase: 'cancelled' as const, changeSet: null }]) {
    useAppStore.setState({ deepResearch: run(patch) });
    expect(await store().requestDiscardDeepResearch()).toBe(true);
    expect(store().deepResearch).toBeNull();
  }
  expect(io.confirm).not.toHaveBeenCalled();
});
