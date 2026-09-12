import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncWorkflow } from './syncWorkflow';
import type { AppState } from '../store';
import type { SyncReport } from './sync';
import { backgroundWork } from './backgroundWorkGovernor';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };
const report = (patch: Partial<SyncReport> = {}): SyncReport => ({ pulled: 1, pushed: 0, conflicts: 0, upToDate: 0, bytesPulled: 0, bytesPushed: 0, totalLocal: 0, totalRemote: 0, durationMs: 0, failed: [], fingerprint: 'abc', cancelled: false, ...patch });
function setup() {
  let generation = 0;
  const state = { vaultPath: '/vault', settings: { syncEnabled: true, syncToken: 'test-key', peers: [{ id: 'one', name: 'One', address: 'one', lastSync: 123 }, { id: 'two', name: 'Two', address: 'two' }] }, syncBusy: false, syncPhase: 'idle', syncReport: null, flushSave: vi.fn(async () => {}), updatePeer: vi.fn() } as unknown as AppState;
  const deps = { get: () => state, set: (patch: Partial<AppState>) => Object.assign(state, patch), generation: () => generation, prepare: vi.fn(async () => {}), transfer: vi.fn(async () => report()), refresh: vi.fn(async () => {}), cancel: vi.fn(async () => {}), log: vi.fn() };
  return { state, deps, actions: createSyncWorkflow(deps), changeVault: () => { generation++; state.vaultPath = '/other'; } };
}
describe('sync workflow boundaries', () => {
  afterEach(() => backgroundWork.resetForTests());

  it('reserves admission before delayed saves/listener setup and flushes before transfer', async () => {
    const { state, deps, actions } = setup(); const save = deferred<void>(); vi.mocked(state.flushSave).mockReturnValueOnce(save.promise);
    const first = actions.syncNow('one'); await actions.syncNow('two');
    expect(state.syncBusy).toBe(true); expect(state.syncPhase).toBe('preparing'); expect(deps.transfer).not.toHaveBeenCalled();
    save.resolve(); await first; expect(deps.transfer).toHaveBeenCalledOnce(); expect(state.syncBusy).toBe(false);
  });
  it('stops before network activity when saving fails', async () => {
    const { state, deps, actions } = setup(); vi.mocked(state.flushSave).mockRejectedValueOnce(new Error('disk full'));
    await actions.syncNow('one'); expect(deps.transfer).not.toHaveBeenCalled(); expect(state.updatePeer).not.toHaveBeenCalled(); expect(state.syncStatus).toContain('disk full'); expect(state.syncBusy).toBe(false);
    expect(state.syncPhase).toBe('error');
  });
  it('cancels during preparation without beginning a transfer', async () => {
    const { state, deps, actions } = setup(); const wait = deferred<void>(); deps.prepare.mockReturnValueOnce(wait.promise);
    const work = actions.syncNow('one'); await Promise.resolve(); await actions.cancelCurrentSync(); wait.resolve(); await work;
    expect(deps.transfer).not.toHaveBeenCalled(); expect(state.syncStatus).toContain('cancelled'); expect(state.syncBusy).toBe(false);
    expect(state.syncPhase).toBe('cancelled');
  });
  it('cancels queued sync without beginning a transfer', async () => {
    const { state, deps, actions } = setup();
    backgroundWork.noteInteraction('typing');
    const work = actions.syncNow('one');
    await vi.waitFor(() => expect(state.syncStatus).toContain('Waiting'));
    expect(state.syncPhase).toBe('waiting');
    await actions.cancelCurrentSync();
    await work;
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.transfer).not.toHaveBeenCalled();
    expect(state.syncStatus).toContain('cancelled before transfer');
    expect(state.syncBusy).toBe(false);
  });
  it('does not start queued transfer after sync is disabled', async () => {
    const { state, deps, actions } = setup();
    backgroundWork.noteInteraction('typing');
    const work = actions.syncNow('one');
    await vi.waitFor(() => expect(state.syncStatus).toContain('Waiting'));
    state.settings.syncEnabled = false;
    await actions.cancelCurrentSync();
    await work;
    expect(deps.transfer).not.toHaveBeenCalled();
    expect(state.syncBusy).toBe(false);
  });
  it('shows stopping immediately while native cancellation is in flight', async () => {
    const { state, deps, actions } = setup(); const transfer = deferred<SyncReport>();
    deps.transfer.mockReturnValueOnce(transfer.promise);
    const work = actions.syncNow('one');
    await vi.waitFor(() => expect(deps.transfer).toHaveBeenCalledOnce());
    expect(state.syncPhase).toBe('transferring');
    await actions.cancelCurrentSync();
    expect(state.syncStatus).toContain('Stopping');
    transfer.resolve(report({ cancelled: true }));
    await work;
  });
  it.each([report({ cancelled: true }), report({ failed: [{ rel: 'a.md', op: 'pull', error: 'offline' }] })])('does not claim success for incomplete work', async result => {
    const { state, deps, actions } = setup(); deps.transfer.mockResolvedValueOnce(result); await actions.syncNow('one');
    const patch = vi.mocked(state.updatePeer).mock.calls[0][1]; expect(patch.lastStatus).toBe('error'); expect(patch).not.toHaveProperty('lastSync'); expect(state.syncStatus).not.toMatch(/^Synced/);
    expect(state.syncPhase).toBe(result.cancelled ? 'cancelled' : 'offline');
  });
  it('marks a manual retry distinctly after failed files', async () => {
    const { state, deps, actions } = setup();
    deps.transfer.mockResolvedValueOnce(report({ failed: [{ rel: 'a.md', op: 'pull', error: 'locked' }] }));
    await actions.syncNow('one');
    const save = deferred<void>();
    vi.mocked(state.flushSave).mockReturnValueOnce(save.promise);
    const retry = deferred<SyncReport>();
    deps.transfer.mockReturnValueOnce(retry.promise);
    const work = actions.syncNow('one');
    await vi.waitFor(() => expect(state.syncPhase).toBe('retrying'));
    save.resolve();
    retry.resolve(report());
    await work;
    expect(deps.transfer).toHaveBeenLastCalledWith('/vault', 'one', 'test-key', null, ['a.md']);
  });
  it('does not send a failed-file retry filter for scan-only failures', async () => {
    const { deps, actions } = setup();
    deps.transfer.mockResolvedValueOnce(report({ failed: [{ rel: 'bad.bin', op: 'scan', error: 'denied' }] }));
    await actions.syncNow('one');
    await actions.syncNow('one');
    expect(deps.transfer).toHaveBeenLastCalledWith('/vault', 'one', 'test-key', null, null);
  });
  it('names failed files in the status and peer summary', async () => {
    const { state, deps, actions } = setup();
    deps.transfer.mockResolvedValueOnce(report({ failed: [
      { rel: 'a.md', op: 'pull', error: 'offline' },
      { rel: 'b.md', op: 'push', error: 'locked' },
      { rel: 'c.md', op: 'conflict', error: 'full' },
      { rel: 'd.md', op: 'pull', error: 'denied' },
    ] }));
    await actions.syncNow('one');
    expect(state.syncStatus).toContain('4 failed: a.md, b.md, c.md, …');
    expect(vi.mocked(state.updatePeer).mock.calls[0][1].lastError).toContain('a.md, b.md, c.md, …');
  });
  it('preserves the current vault and stops a multi-device batch after a switch', async () => {
    const { deps, actions, changeVault } = setup(); const transfer = deferred<SyncReport>(); deps.transfer.mockReturnValueOnce(transfer.promise);
    const work = actions.syncAll(); await vi.waitFor(() => expect(deps.transfer).toHaveBeenCalledOnce()); changeVault(); transfer.resolve(report()); await work;
    expect(deps.refresh).not.toHaveBeenCalled(); expect(deps.transfer).toHaveBeenCalledOnce();
  });
  it('refreshes additions without replacing the workspace and keeps a successful report if refresh fails', async () => {
    const { state, deps, actions } = setup(); deps.refresh.mockRejectedValueOnce(new Error('drive removed')); await actions.syncNow('one');
    expect(state.syncReport?.pulled).toBe(1); expect(state.syncStatus).toContain('refresh failed'); expect(state.syncBusy).toBe(false);
  });
  it('releases admission after a rejected setup and permits retry', async () => {
    const { deps, actions } = setup(); deps.prepare.mockRejectedValueOnce(new Error('listener unavailable')); await actions.syncNow('one'); await actions.syncNow('one'); expect(deps.transfer).toHaveBeenCalledOnce();
  });
});
