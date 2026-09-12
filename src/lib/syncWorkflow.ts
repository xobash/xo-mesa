import type { AppState } from '../store';
import type { SyncLogEntry, SyncReport } from './sync';
import { markMesaPerf } from './mesaPerf';
import { BackgroundWorkCancelledError, backgroundWork, type BackgroundWorkHandle } from './backgroundWorkGovernor';

type SyncState = Pick<AppState, 'vaultPath' | 'settings' | 'syncBusy' | 'syncStatus' | 'syncPhase' | 'syncLastPeerId' | 'syncProgress' | 'syncReport' | 'updatePeer' | 'flushSave'>;
interface Dependencies {
  get(): SyncState;
  set(patch: Partial<SyncState>): void;
  generation(): number;
  prepare(): Promise<void>;
  transfer(root: string, address: string, token: string, fingerprint: string | null, retry: string[] | null): Promise<SyncReport>;
  refresh(root: string, current: () => boolean): Promise<void>;
  cancel(): Promise<void>;
  log(level: SyncLogEntry['level'], message: string): void;
}

export function syncStatusLine(name: string, report: SyncReport): string {
  const failed = report.failed.filter(file => file.error !== 'cancelled');
  let message = `${report.cancelled ? 'Sync cancelled with' : failed.length ? 'Sync incomplete with' : 'Synced with'} ${name} — ↓${report.pulled} ↑${report.pushed}`;
  if (report.conflicts) message += ` · ${report.conflicts} conflict ${report.conflicts === 1 ? 'copy' : 'copies'} to review`;
  if (failed.length) {
    const examples = failed.slice(0, 3).map(file => file.rel).join(', ');
    message += ` · ${failed.length} failed: ${examples}${failed.length > 3 ? ', …' : ''}`;
  }
  return message;
}

function syncFailurePhase(report: SyncReport): SyncState["syncPhase"] {
  if (report.cancelled) return "cancelled";
  const failed = report.failed.filter(file => file.error !== 'cancelled');
  if (failed.some(file => /offline|unreachable|timed? out|timeout|network|connection|refused|dns/i.test(file.error))) {
    return "offline";
  }
  if (failed.length) return "incomplete";
  return "complete";
}

/** Owns admission, save-before-sync and completion, without reopening the vault. */
export function createSyncWorkflow(deps: Dependencies) {
  const { get, set } = deps;
  let batch = false;
  let batchCancelled = false;
  let currentOp: { id: number; cancelled: boolean; transfer?: BackgroundWorkHandle<SyncReport> } | null = null;
  let nextOpId = 0;
  let transferring = false;
  async function run(peerId: string): Promise<void> {
    const state = get();
    const peer = state.settings.peers.find(peer => peer.id === peerId);
    if (!state.vaultPath || !peer) return;
    if (!state.settings.syncEnabled) { set({ syncStatus: 'Sync is disabled.', syncPhase: 'disabled' }); return; }
    if (state.syncBusy) return;
    const token = peer.token || state.settings.syncToken;
    if (!token) { set({ syncStatus: 'Set the sync key first.', syncPhase: 'error' }); return; }
    const op = { id: ++nextOpId, cancelled: false, transfer: undefined as BackgroundWorkHandle<SyncReport> | undefined };
    currentOp = op;
    const root = state.vaultPath, generation = deps.generation();
    const current = () => get().vaultPath === root && deps.generation() === generation;
    const admitted = () => currentOp === op && current() && !op.cancelled && get().settings.syncEnabled;
    // Reserve synchronously, before listener installation or saves can yield.
    const retryRels =
      state.syncLastPeerId === peer.id
        ? Array.from(new Set(
            state.syncReport?.failed
              .filter(file => file.error !== 'cancelled' && (file.op === 'pull' || file.op === 'push' || file.op === 'conflict'))
              .map(file => file.rel) ?? []
          ))
        : [];
    const priorFailed = retryRels.length > 0;
    set({ syncBusy: true, syncStatus: `Preparing sync with ${peer.name}…`, syncPhase: priorFailed ? 'retrying' : 'preparing', syncLastPeerId: peer.id, syncProgress: null, syncReport: null });
    markMesaPerf('sync-start', { peer: peer.name });
    let contacted = false;
    try {
      await get().flushSave();
      if (!admitted()) return;
      await deps.prepare();
      if (!admitted()) return;
      set({ syncStatus: `Waiting to sync with ${peer.name}…`, syncPhase: 'waiting' });
      op.transfer = backgroundWork.enqueue('sync', async () => {
        if (!admitted()) throw new BackgroundWorkCancelledError('Sync cancelled before transfer.');
        contacted = true;
        transferring = true;
        set({ syncStatus: `Syncing with ${peer.name}…`, syncPhase: 'transferring' });
        deps.log('info', `requested sync with ${peer.name} (${peer.address})`);
        return deps.transfer(root, peer.address, token, peer.fingerprint ?? null, retryRels.length ? retryRels : null);
      });
      const report = await op.transfer.promise;
      if (currentOp !== op) return;
      const failed = report.failed.filter(file => file.error !== 'cancelled');
      const success = !report.cancelled && failed.length === 0;
      get().updatePeer(peer.id, {
        ...(success ? { lastSync: Date.now() } : {}),
        lastChecked: Date.now(),
        lastStatus: success ? 'ok' : 'error',
        lastError: report.cancelled ? 'Sync cancelled; completed files are preserved. Retry to continue.'
          : failed.length ? `${failed.length} files failed: ${failed.slice(0, 3).map(file => file.rel).join(', ')}${failed.length > 3 ? ', …' : ''}` : undefined,
        fingerprint: peer.fingerprint || report.fingerprint || undefined,
      });
      let message = syncStatusLine(peer.name, report);
      if (current() && (report.pulled > 0 || report.conflicts > 0)) {
        try { await deps.refresh(root, current); }
        catch (error) { message += ` · File list refresh failed: ${String(error)}`; }
      }
      if (!current()) message += ' · Active vault changed; its workspace was preserved.';
      if (currentOp === op) set({ syncReport: report, syncStatus: message, syncPhase: syncFailurePhase(report) });
      markMesaPerf('sync-complete', { pulled: report.pulled, pushed: report.pushed, conflicts: report.conflicts, failed: failed.length });
    } catch (error) {
      if (error instanceof BackgroundWorkCancelledError) return;
      const message = String(error);
      deps.log('error', `sync with ${peer.name} failed: ${message}`);
      // A local save or listener failure does not make the remote device unhealthy.
      if (contacted) get().updatePeer(peer.id, { lastChecked: Date.now(), lastStatus: 'error', lastError: message });
      if (currentOp === op) set({ syncStatus: `Sync stopped: ${message}`, syncPhase: /offline|unreachable|timed? out|timeout|network|connection|refused|dns/i.test(message) ? 'offline' : 'error' });
    } finally {
      if (currentOp === op) {
        transferring = false;
        if (op.cancelled && !contacted) set({ syncStatus: "Sync cancelled before transfer.", syncPhase: 'cancelled' });
        if (!current() && !contacted) set({ syncStatus: 'Sync stopped because the active vault changed.', syncPhase: 'cancelled' });
        else if (!get().settings.syncEnabled) set({ syncStatus: 'Sync disabled. Completed files were preserved.', syncPhase: 'disabled' });
        set({ syncBusy: false });
        currentOp = null;
      } else if (transferring) {
        transferring = false;
      }
    }
  }
  return {
    cancelCurrentSync: async () => {
      const op = currentOp;
      batchCancelled = true;
      if (op) op.cancelled = true;
      if (get().syncBusy) set({ syncStatus: 'Stopping sync… completed files are preserved.', syncPhase: 'cancelled' });
      if (op?.transfer?.cancel(new BackgroundWorkCancelledError('Sync cancelled before transfer.'))) return;
      if (transferring) {
        try { await deps.cancel(); }
        catch (error) { set({ syncStatus: `Sync cancellation failed: ${String(error)}`, syncPhase: 'error' }); }
      }
    },
    syncNow: async (peerId: string) => { if (!batch) await run(peerId); },
    syncAll: async () => {
      if (batch || get().syncBusy) return;
      batch = true;
      batchCancelled = false;
      const root = get().vaultPath, generation = deps.generation();
      try {
        for (const peer of [...get().settings.peers]) {
          if (get().vaultPath !== root || deps.generation() !== generation || !get().settings.syncEnabled) break;
          await run(peer.id);
          if (batchCancelled || get().syncReport?.cancelled) break;
        }
      } finally { batch = false; }
    },
  };
}
