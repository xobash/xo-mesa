// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../lib/settings';
import { THEME_KEY } from '../lib/persistedUi';
import type { AppState } from '../storeTypes';
import { followOtherWindows } from './settingsFollow';

let stop = () => {};
afterEach(() => stop());

function fakeStore() {
  let state = { theme: 'void', uiStyle: 'classic', settings: { ...DEFAULT_SETTINGS, syncDeviceName: 'Here', peers: [] } } as unknown as AppState;
  return { getState: () => state, setState: (patch: Partial<AppState>) => { state = { ...state, ...patch }; } };
}
const fire = (key: string, newValue: string, oldValue: string | null = null) => window.dispatchEvent(new StorageEvent('storage', { key, newValue, oldValue }));

it('follows a theme and graph setting another window saved, keeping this window\'s sync identity', () => {
  const store = fakeStore();
  stop = followOtherWindows(store);
  fire(THEME_KEY, 'paper');
  fire(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, graphNodeSize: 2, syncDeviceName: 'Elsewhere' }));
  expect(store.getState().theme).toBe('paper');
  expect(store.getState().settings.graphNodeSize).toBe(2);
  expect(store.getState().settings.syncDeviceName).toBe('Here');
});

it('ignores unreadable or unknown values', () => {
  const store = fakeStore();
  const before = store.getState();
  stop = followOtherWindows(store);
  fire(THEME_KEY, 'neon');
  fire(SETTINGS_KEY, '{broken');
  expect(store.getState()).toBe(before);
});

it('applies only what the other window changed, never its stale copy of a key changed here', () => {
  const store = fakeStore();
  stop = followOtherWindows(store);
  const stored = { ...DEFAULT_SETTINGS, graphNodeSize: 1, sidebarOpen: true, syncDeviceName: 'Elsewhere' };
  // This window has since turned the sidebar off; the other window only changed node size.
  store.setState({ settings: { ...store.getState().settings, sidebarOpen: false } } as never);
  fire(SETTINGS_KEY, JSON.stringify({ ...stored, graphNodeSize: 3 }), JSON.stringify(stored));
  expect(store.getState().settings.graphNodeSize).toBe(3);
  expect(store.getState().settings.sidebarOpen).toBe(false);
});
