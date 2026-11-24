import { describe, expect, it, vi } from 'vitest';
import { canCheckNow, canDownload, checkedAgo, normalizeUpdateStatus, restartToUpdate, supersedes, updateStatusLine, type UpdateStatus } from './updates';

const base = { currentVersion: '0.1.0', support: { kind: 'automatic' }, checkedAt: 5 };
const status = (fields: Record<string, unknown>): UpdateStatus => normalizeUpdateStatus({ ...base, ...fields });

describe('update status', () => {
  it('reads every native state and its line', () => {
    expect(updateStatusLine(status({ state: 'checking' }))).toBe('Checking for updates…');
    expect(updateStatusLine(status({ state: 'upToDate' }))).toBe('Mesa is up to date.');
    expect(updateStatusLine(status({ state: 'ready', version: '0.2.0' }))).toBe('Mesa 0.2.0 is ready. It installs when you quit Mesa.');
    expect(updateStatusLine(status({ state: 'error', message: 'Offline.' }))).toBe('Offline.');
    const notify = status({ state: 'available', version: '0.2.0', support: { kind: 'notifyOnly', reason: 'Use your package manager.' } });
    expect(updateStatusLine(notify)).toBe('Mesa 0.2.0 is available. Use your package manager.');
    expect(updateStatusLine(status({ state: 'idle', support: { kind: 'off', reason: 'Development build.' } }))).toBe('Development build.');
  });

  it('keeps download progress whole, bounded and optional', () => {
    const downloading = status({ state: 'downloading', version: '0.2.0', downloaded: 10, total: 20, percent: 50.7 });
    expect(downloading).toMatchObject({ state: 'downloading', percent: 50, total: 20, downloaded: 10 });
    expect(status({ state: 'downloading', version: '0.2.0', percent: 400 })).toMatchObject({ percent: 100, downloaded: 0 });
    expect(status({ state: 'downloading', version: '0.2.0', percent: null, total: null })).toMatchObject({ percent: null, total: null });
    // The live status line never carries the changing percent.
    expect(updateStatusLine(downloading)).toBe('Downloading Mesa 0.2.0…');
  });

  it('reads malformed payloads as idle and updates off, never throwing', () => {
    for (const payload of [null, 'x', 3, { state: 'bogus' }, { support: { kind: 'automatic?' } }]) {
      const read = normalizeUpdateStatus(payload);
      expect(read.state).toBe('idle');
      expect(read.support.kind).toBe('off');
      expect(canCheckNow(read)).toBe(false);
    }
    expect(status({ state: 'error', message: 7 })).toMatchObject({ state: 'error', message: 'The update check failed.' });
  });

  it('offers Check now only when nothing is in progress', () => {
    for (const state of ['idle', 'upToDate', 'available', 'error']) expect(canCheckNow(status({ state, version: '1.0.0', message: 'm' }))).toBe(true);
    for (const state of ['checking', 'downloading', 'ready']) expect(canCheckNow(status({ state, version: '1.0.0' }))).toBe(false);
  });
});

describe('ordering, age and download offers', () => {
  it('drops a status older than the one shown', () => {
    expect(supersedes(status({ seq: 5 }), status({ seq: 4 }))).toBe(true);
    expect(supersedes(status({ seq: 5 }), status({ seq: 5 }))).toBe(true);
    expect(supersedes(status({ seq: 4 }), status({ seq: 5 }))).toBe(false);
    expect(status({ seq: -3 }).seq).toBe(0);
  });

  it('says when the last check ran', () => {
    const now = 10 * 24 * 3_600_000;
    expect(checkedAgo(null, now)).toBe('');
    expect(checkedAgo(now - 20_000, now)).toBe('Checked just now');
    expect(checkedAgo(now - 2 * 60_000, now)).toBe('Checked 2 min ago');
    expect(checkedAgo(now - 3 * 3_600_000, now)).toBe('Checked 3 h ago');
    expect(checkedAgo(now - 24 * 3_600_000, now)).toBe('Checked 1 day ago');
    expect(checkedAgo(now + 60_000, now)).toBe('Checked just now');
  });

  it('offers Download and install only for a self-updating install with a found version', () => {
    expect(canDownload(status({ state: 'available', version: '0.2.0' }))).toBe(true);
    expect(canDownload(status({ state: 'available', version: '0.2.0', support: { kind: 'notifyOnly', reason: 'r' } }))).toBe(false);
    expect(canDownload(status({ state: 'upToDate' }))).toBe(false);
  });

  it('explains a version that is waiting a day after a failed install', () => {
    const waiting = status({ state: 'available', version: '0.2.0', lastFailure: { version: '0.2.0', kind: 'signature' } });
    expect(waiting.lastFailure).toEqual({ version: '0.2.0', kind: 'signature' });
    expect(updateStatusLine(waiting)).toMatch(/retries it automatically once a day/);
    expect(status({ lastFailure: { version: '0.2.0', kind: 'other' } }).lastFailure).toBeNull();
  });
});

describe('restart to update', () => {
  it('restarts only after the save flush succeeds and nothing is left unsaved', async () => {
    const order: string[] = [];
    const deps = { flush: vi.fn(async () => { order.push('flush'); }), pending: vi.fn(() => false), restart: vi.fn(async () => { order.push('restart'); }) };
    expect(await restartToUpdate(deps)).toBe('');
    expect(order).toEqual(['flush', 'restart']);
  });

  it('never restarts while a save fails', async () => {
    const restart = vi.fn(async () => {});
    const message = await restartToUpdate({ flush: async () => { throw new Error('note.md changed on disk'); }, pending: () => false, restart });
    expect(message).toBe('Restart stopped: note.md changed on disk');
    expect(restart).not.toHaveBeenCalled();
  });

  it('never restarts while an edit is still unsaved after the flush', async () => {
    const restart = vi.fn(async () => {});
    expect(await restartToUpdate({ flush: async () => {}, pending: () => true, restart })).toMatch(/not saved/);
    expect(restart).not.toHaveBeenCalled();
  });

  it('shows the native refusal, such as a running Pi session', async () => {
    const message = await restartToUpdate({ flush: async () => {}, pending: () => false, restart: async () => { throw 'Stop Pi before restarting to update.'; } });
    expect(message).toBe('Stop Pi before restarting to update.');
  });
});
