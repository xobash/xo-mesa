// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore } from '../store';
import { createPersistenceController } from './persistence';
const io = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), writeNote: io.write }));
vi.mock('../lib/textRevisionHistory', async original => ({ ...await original<object>(), recordTextRevisionAsync: async () => ({ id: 'test' }) }));
it('retains failed drafts independently and retries their exact disk baselines', async () => {
  const files = ['a', 'b'].map(name => ({ path: `/vault/${name}.md`, relPath: `${name}.md`, name, ext: 'md', isMarkdown: true }));
  const state = createStore(() => ({ ...useAppStore.getInitialState(), vaultPath: '/vault', files, notes: {}, contentCache: {}, fileFor: (rel: string) => files.find(f => f.relPath === rel) }));
  const controller = createPersistenceController({ get: state.getState, set: state.setState, getGeneration: () => 0, refreshMissingExternalFiles: async () => { } });
  io.write.mockRejectedValueOnce(Error('locked')).mockResolvedValue(undefined);
  await controller.saveTextMutation(files[0], 'draft a', 'disk a');
  await controller.saveTextMutation(files[1], 'draft b', 'disk b');
  expect(controller.textSaves.isDirty(files[0].path)).toBe(true);
  expect(controller.textSaves.isDirty(files[1].path)).toBe(false);
  expect(Object.keys(state.getState().textSaveIssues)).toEqual([files[0].path]);
  await controller.actions.retryTextSaveIssue(files[0].path);
  expect(io.write).toHaveBeenLastCalledWith(files[0], 'draft a', 'disk a');
  expect(controller.textSaves.isDirty(files[0].path)).toBe(false);
  expect(state.getState().textSaveIssues).toEqual({});
});
