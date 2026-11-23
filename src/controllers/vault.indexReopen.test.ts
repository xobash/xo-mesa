// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import { forkContentCache } from '../lib/documentWorkingSet';
import type { NoteMeta, VaultFile } from '../types';
import { createVaultController } from './vault';

const io = vi.hoisted(() => ({ index: vi.fn(), watch: vi.fn(async () => () => {}) }));
const files: VaultFile[] = ['A.md', 'B.md'].map(relPath => ({ path: `/v/${relPath}`, relPath, name: relPath.slice(0, -3), ext: 'md', isMarkdown: true }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), authorizeVaultRoot: async () => {}, assertVaultRootAvailable: async () => {},
  scanVault: async () => files, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }), watchVault: io.watch }));
vi.mock('../lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: io.index }));
const note = (relPath: string, links: string[]): NoteMeta => ({ relPath, title: relPath.slice(0, -3), rawLinks: links, tags: [], aliases: [] });

it('shows the stored index at once, then patches changed documents without replacing live edits', async () => {
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {}, selectFile: vi.fn(async () => {}) }));
  let finish!: () => void;
  let shownAt: Partial<AppState> = {};
  io.index.mockImplementation(async (options: Parameters<typeof import('../lib/vaultIndex').loadIndexedNotes>[0]) => {
    options.onCached!({ notes: { 'A.md': note('A.md', []), 'B.md': note('B.md', []) }, cache: { 'A.md': 'a stored', 'B.md': 'b stored' }, missing: 0 });
    const shown = state.getState();
    shownAt = { indexingTextFiles: shown.indexingTextFiles, notes: shown.notes, notesIndexPending: shown.notesIndexPending };
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
  expect(shownAt.notesIndexPending).toBe(false);
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

it('holds the note-index flag through the selected-note read and clears it when indexing fails', async () => {
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {} }));
  let pendingDuringSelect: boolean | undefined;
  state.setState({ selectFile: vi.fn(async (rel: string) => {
    pendingDuringSelect = state.getState().notesIndexPending;
    state.setState({ notes: { [rel]: note(rel, []) } });
  }) });
  let fail!: (error: Error) => void;
  io.index.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v');
  expect(pendingDuringSelect).toBe(true);
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  expect(state.getState().notesIndexPending).toBe(true);
  fail(new Error('disk gone'));
  await vi.waitFor(() => expect(state.getState().notesIndexPending).toBe(false));
  expect(state.getState().status).toContain('Text indexing failed');
  controller.dispose();
});

it('refreshes a torn-out graph window in place: notes and selection never blank, changed documents patch', async () => {
  const shown = { 'A.md': note('A.md', ['B']), 'B.md': note('B.md', []) };
  const selectFile = vi.fn(async () => {});
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/v', files, notes: shown, activePath: 'B.md', contentCache: {}, selectFile }));
  const seen: { notes: number; pending: boolean; active: string | null }[] = [];
  state.subscribe(s => seen.push({ notes: Object.keys(s.notes).length, pending: s.notesIndexPending, active: s.activePath }));
  io.index.mockImplementation(async (options: Parameters<typeof import('../lib/vaultIndex').loadIndexedNotes>[0]) => {
    options.onCached!({ notes: { 'A.md': note('A.md', []) }, cache: { 'A.md': 'a stored' }, missing: 1 });
    return { notes: { 'A.md': note('A.md', ['B']), 'B.md': note('B.md', ['A']) }, cache: {}, reused: 1, read: 1, skipped: [], failed: [],
      changed: new Map([['B.md', 'b disk [[A]]']]) };
  });
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v', { keepShown: true });
  await vi.waitFor(() => expect(state.getState().status).toBe('2 documents indexed'));
  expect(seen.every(s => s.notes === 2 && !s.pending && s.active === 'B.md')).toBe(true);
  expect(selectFile).not.toHaveBeenCalled();
  const final = state.getState();
  expect(final.notes['A.md'].rawLinks).toEqual(['B']);
  expect(final.notes['B.md'].rawLinks).toEqual(['A']);
  controller.dispose();
});

it('fills a torn-out graph window from a partial snapshot and drops notes whose files are gone', async () => {
  // The source window was still indexing: its snapshot held one note, plus one since deleted.
  const shown = { 'A.md': note('A.md', ['B']), 'Gone.md': note('Gone.md', []) };
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/v', files, notes: shown, activePath: null, contentCache: {}, selectFile: vi.fn(async () => {}) }));
  io.index.mockImplementation(async () => ({ notes: { 'A.md': note('A.md', ['B']), 'B.md': note('B.md', ['A']) }, cache: {}, reused: 0, read: 2, skipped: [], failed: [], changed: new Map() }));
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v', { keepShown: true });
  await vi.waitFor(() => expect(state.getState().status).toBe('2 documents indexed'));
  expect(Object.keys(state.getState().notes).sort()).toEqual(['A.md', 'B.md']);
  controller.dispose();
});

it('never brings back a note renamed or deleted while indexing ran', async () => {
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {}, selectFile: vi.fn(async () => {}) }));
  io.index.mockImplementation(async () => {
    // B.md is deleted (watcher or rename) before the pass publishes.
    state.setState({ files: state.getState().files.filter((f) => f.relPath !== 'B.md') });
    return { notes: { 'A.md': note('A.md', []), 'B.md': note('B.md', []) }, cache: { 'A.md': 'a', 'B.md': 'b' }, reused: 0, read: 2, skipped: [], failed: [], changed: new Map() };
  });
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v');
  await vi.waitFor(() => expect(state.getState().status).toMatch(/documents indexed/));
  expect(Object.keys(state.getState().notes)).toEqual(['A.md']);
  expect('B.md' in state.getState().contentCache).toBe(false);
  controller.dispose();
});

it('restores the current vault watcher when a pending save fails during a switch', async () => {
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {}, selectFile: vi.fn(async () => {}) }));
  io.index.mockImplementation(async () => ({ notes: {}, cache: {}, reused: 0, read: 0, skipped: [], failed: [], changed: new Map() }));
  let flushes = 0, failAt = Infinity;
  const textSaves = { flushAll: vi.fn(async () => { if (++flushes === failAt) throw new Error('conflict'); }) } as unknown as TextSaveCoordinator<VaultFile>;
  const controller = createVaultController({ get: state.getState, set: state.setState, textSaves, resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v');
  await vi.waitFor(() => expect(io.watch).toHaveBeenCalled());
  const watchedBefore = io.watch.mock.calls.length;
  failAt = flushes + 2; // the switch's second flush (after the scan) fails
  await controller.actions.openVault('/other');
  expect(state.getState().vaultPath).toBe('/v');
  await vi.waitFor(() => expect(io.watch.mock.calls.length).toBe(watchedBefore + 1));
  expect((io.watch.mock.calls.at(-1) as unknown[])[0]).toBe('/v');
  controller.dispose();
});
