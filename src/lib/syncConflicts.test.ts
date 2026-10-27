import { describe, expect, it } from 'vitest';
import { findSyncConflicts, conflictBackupPath, reviewedConflictPath } from './syncConflicts';
import type { VaultFile } from '../types';
const file = (relPath: string) => ({ relPath } as VaultFile);
describe('conflict discovery', () => {
  it('finds dated and numbered copies without confusing dotted folders or extensions', () => {
    const files = ['v1.2/Note.md', 'v1.2/Note (conflict from device 2026-09-08).md', 'v1.2/Note (conflict from device 2026-09-08) (12).md', 'README', 'README (conflict from device 2026-09-08)', 'orphan (conflict from device 2026-09-08).md'].map(file);
    expect(findSyncConflicts(files).map(c => c.original.relPath).sort()).toEqual(['README', 'v1.2/Note.md', 'v1.2/Note.md']);
  });
  it('does not classify normal filenames or absent originals', () => { expect(findSyncConflicts(['Note.md', 'Note (conflict from prose).md'].map(file))).toEqual([]); });
  it('preserves real extensions in retained original copies', () => { expect(conflictBackupPath('v1.2/Note.txt', '123')).toBe('v1.2/Note (before sync review 123).txt'); expect(conflictBackupPath('v1.2/README', '123')).toBe('v1.2/README (before sync review 123)'); });
  it('names reviewed conflict copies so they no longer look unresolved', () => {
    const reviewed = reviewedConflictPath('v1.2/Note (conflict from device 2026-09-08).md', '123');
    expect(reviewed).toBe('v1.2/Note (conflict from device 2026-09-08) (reviewed 123).md');
    expect(findSyncConflicts([file('v1.2/Note.md'), file(reviewed)])).toEqual([]);
  });
});
