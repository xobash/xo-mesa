import type { VaultFile } from '../types';
export interface SyncConflict { copy: VaultFile; original: VaultFile; peer: string; date: string }
/** Names identify candidates, never authority to overwrite a file. */
export function findSyncConflicts(files: VaultFile[]): SyncConflict[] {
  const byPath = new Map(files.map(file => [file.relPath, file]));
  const result: SyncConflict[] = [];
  for (const copy of files) {
    const slash = copy.relPath.lastIndexOf('/');
    const name = copy.relPath.slice(slash + 1);
    const match = /^(.*) \(conflict from (.+) (\d{4}-\d{2}-\d{2})\)(?: \([2-9]\d*\)| \(1\d+\))?(\.[^.]*)?$/.exec(name);
    if (!match) continue;
    const original = byPath.get(copy.relPath.slice(0, slash + 1) + match[1] + (match[4] ?? ''));
    if (original && original !== copy) result.push({ copy, original, peer: match[2], date: match[3] });
  }
  return result.sort((a, b) => b.date.localeCompare(a.date) || a.copy.relPath.localeCompare(b.copy.relPath));
}
export function conflictBackupPath(rel: string, id: string): string {
  const slash = rel.lastIndexOf('/'), dot = rel.lastIndexOf('.');
  const split = dot > slash ? dot : rel.length;
  return `${rel.slice(0, split)} (before sync review ${id})${rel.slice(split)}`;
}

export function reviewedConflictPath(rel: string, id: string): string {
  const slash = rel.lastIndexOf('/'), dot = rel.lastIndexOf('.');
  const split = dot > slash ? dot : rel.length;
  return `${rel.slice(0, split)} (reviewed ${id})${rel.slice(split)}`;
}
