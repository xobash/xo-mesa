// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import { forkContentCache } from '../lib/documentWorkingSet';
import type { NoteMeta, VaultFile } from '../types';
import { createVaultController } from './vault';

const io = vi.hoisted(() => ({ index: vi.fn() }));
const files: VaultFile[] = ['A.md', 'B.md'].map(relPath => ({ path: `/v/${relPath}`, relPath, name: relPath.slice(0, -3), ext: 'md', isMarkdown: true }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), authorizeVaultRoot: async () => {}, assertVaultRootAvailable: async () => {},
  scanVault: async () => files, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }), watchVault: async () => () => {} }));
vi.mock('../lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: io.index }));
const note = (relPath: string, links: string[]): NoteMeta => ({ relPath, title: relPath.slice(0, -3), rawLinks: links, tags: [], aliases: [] });

it('shows the stored index at once, then patches changed documents without replacing live edits', async () => {
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {}, selectFile: vi.fn(async () => {}) }));
  let finish!: () => void;
  let shownAt: Partial<AppState> = {};
  io.index.mockImplementation(async (options: Parameters<typeof import('../lib/vaultIndex').loadIndexedNotes>[0]) => {
    options.onCached!({ notes: { 'A.md': note('A.md', []), 'B.md': note('B.md', []) }, cache: { 'A.md': 'a stored', 'B.md': 'b stored' }, missing: 0 });
    const shown = state.getState();
    shownAt = { indexingTextFiles: shown.indexingTextFiles, notes: shown.notes };
    // A live edit lands while verification runs.
    state.setState({ notes: { ...shown.notes, 'A.md': note('A.md', ['Live']) }, contentCache: forkContentCache(shown.contentCache, { 'A.md': 'a live' }) });
    await new Promise<void>(resolve => { finish = resolve; });
    options.onProgress?.(2, 2);
    return { notes: { 'A.md': note('A.md', ['Disk']), 'B.md': note('B.md', ['A']) }, cache: {}, reused: 0, read: 2, skipped: [], failed: [],
      changed: new Map([['A.md', 'a disk'], ['B.md', 'b disk [[A]]']]) };
  });
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(shownAt.indexingTextFiles).toBe(0);
  expect(Object.keys(shownAt.notes ?? {}).sort()).toEqual(['A.md', 'B.md']);
  finish();
  await vi.waitFor(() => expect(state.getState().status).toBe('2 documents indexed'));
  const final = state.getState();
  expect(final.contentCache['A.md']).toBe('a live');
  expect(final.notes['A.md'].rawLinks).toEqual(['Live']);
  expect(final.contentCache['B.md']).toBe('b disk [[A]]');
  expect(final.notes['B.md'].rawLinks).toEqual(['A']);
  expect(final.indexingTextFiles).toBe(0);
  controller.dispose();
});
