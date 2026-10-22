// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { VaultFile } from './types';
const io = vi.hoisted(() => ({ confirm: vi.fn(async (_message: string, _options?: unknown) => false), rename: vi.fn(), remove: vi.fn() }));
vi.mock('./lib/confirmAction', () => ({ confirmAction: io.confirm }));
vi.mock('./lib/vault', async original => ({ ...await original<object>(), renameVaultFile: io.rename, removeFile: io.remove }));
import { useAppStore } from './store';
const file = (relPath: string): VaultFile => ({ path: `/v/${relPath}`, relPath, name: relPath.replace(/\..*$/, ''), ext: relPath.split('.').pop()!, isMarkdown: relPath.endsWith('.md') });
const initial = useAppStore.getState();
const store = () => useAppStore.getState();
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(initial, true);
  useAppStore.setState({ vaultPath: '/v', files: [file('Scan.pdf'), file('Note.md')], notes: {}, contentCache: { 'Note.md': 'text' },
    activePath: 'Scan.pdf', openTabs: ['Scan.pdf', 'Note.md'], activeContentState: 'ready' });
  store().setBinaryDirty('Scan.pdf', true);
});

it('asks before leaving, closing, renaming or deleting a PDF with unsaved edits', async () => {
  await store().selectFile('Note.md');
  expect(io.confirm).toHaveBeenCalledOnce();
  expect(store().activePath).toBe('Scan.pdf');

  store().closeTab('Scan.pdf');
  await vi.waitFor(() => expect(io.confirm).toHaveBeenCalledTimes(2));
  expect(store().openTabs).toContain('Scan.pdf');

  await store().renameNote('Scan.pdf', 'Renamed');
  await store().deleteEntry('Scan.pdf');
  expect(io.confirm).toHaveBeenCalledTimes(4);
  expect(io.rename).not.toHaveBeenCalled();
  expect(io.remove).not.toHaveBeenCalled();
  expect(io.confirm.mock.calls[0][0]).toContain('Scan.pdf has unsaved PDF edits');
});

it('continues after the user confirms discarding PDF edits and leaves clean files alone', async () => {
  io.confirm.mockResolvedValue(true);
  store().closeTab('Scan.pdf');
  await vi.waitFor(() => expect(store().activePath).toBe('Note.md'));
  expect(store().openTabs).not.toContain('Scan.pdf');
  expect(store().dirtyBinaryPaths).toEqual([]);
  io.confirm.mockClear();
  await store().selectFile('Scan.pdf');
  expect(io.confirm).not.toHaveBeenCalled();
});
