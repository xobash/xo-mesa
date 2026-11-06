import { describe, expect, it } from 'vitest';
import { syncAttention, type SyncAttentionInput } from './syncAttention';
import type { SyncReport } from './sync';

const healthy: SyncAttentionInput = {
  syncEnabled: true, syncBusy: false, syncPhase: 'complete', syncStatus: '', syncReport: null,
  peers: [{ name: 'Laptop', lastStatus: 'ok' }, { name: 'Desktop' }],
};
const report = (conflicts: number) => ({ conflicts, failed: [], cancelled: false }) as unknown as SyncReport;

describe('syncAttention', () => {
  it('stays quiet when sync is healthy, off or running', () => {
    expect(syncAttention(healthy)).toBeNull();
    const failed = { ...healthy, peers: [{ name: 'Laptop', lastStatus: 'error' as const }] };
    expect(syncAttention({ ...failed, syncEnabled: false })).toBeNull();
    expect(syncAttention({ ...failed, syncBusy: true })).toBeNull();
  });

  it('names a failed device and keeps its error for the tooltip', () => {
    const issue = syncAttention({ ...healthy, peers: [{ name: 'Laptop', lastStatus: 'error', lastError: 'connection refused' }] });
    expect(issue?.summary).toBe('Sync: failed with Laptop');
    expect(issue?.detail).toContain('connection refused');
  });

  it('counts several failed devices', () => {
    const issue = syncAttention({ ...healthy, peers: [{ name: 'A', lastStatus: 'error' }, { name: 'B', lastStatus: 'error' }] });
    expect(issue?.summary).toBe('Sync: failed with 2 devices');
    expect(issue?.detail).toContain('A, B');
  });

  it('reports failures before any device was contacted', () => {
    expect(syncAttention({ ...healthy, syncPhase: 'error', syncStatus: 'Set the sync key first.' })?.summary).toBe('Sync: stopped');
    expect(syncAttention({ ...healthy, syncPhase: 'offline' })?.summary).toBe('Sync: offline');
  });

  it('asks for review of conflict copies from the last sync', () => {
    expect(syncAttention({ ...healthy, syncReport: report(2) })?.summary).toBe('Sync: 2 conflict copies to review');
    expect(syncAttention({ ...healthy, syncReport: report(0) })).toBeNull();
  });

  it('starts every summary with the label the tray popover strips', () => {
    for (const issue of [
      syncAttention({ ...healthy, syncPhase: 'error' }),
      syncAttention({ ...healthy, syncReport: report(1) }),
      syncAttention({ ...healthy, peers: [{ name: 'X', lastStatus: 'error' }] }),
    ]) expect(issue?.summary.startsWith('Sync: ')).toBe(true);
  });
});
