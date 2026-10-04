// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore } from '../store';
import { createWorkspaceController } from './workspace';
it('composes placement without losing document state or user pane dimensions', async () => {
  const initial = useAppStore.getInitialState();
  const state = createStore(() => ({ ...initial, activePath: 'draft.md', content: 'unsaved', settings: { ...initial.settings, sidebarWidth: 333, rightWidth: 444 } }));
  const controller = createWorkspaceController({ get: state.getState, set: state.setState, commitSettings: settings => state.setState({ settings }) });
  controller.actions.applyWorkspacePreset('research');
  expect(state.getState()).toMatchObject({ activePath: 'draft.md', content: 'unsaved', settings: { rightStack: ['agent', 'preview'], sidebarWidth: 333, rightWidth: 444 } });
  await controller.actions.openDocWindow('other.md');
  expect(state.getState()).toMatchObject({ popoutDoc: 'other.md', activePath: 'draft.md', content: 'unsaved' });
});
