// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
const mocks = vi.hoisted(() => ({
  generation: 1,
  purge: vi.fn(),
  section: 'deleted',
  confirm: vi.fn(async (_message: string, _options?: unknown) => true),
  purgeRevision: vi.fn(async () => {}),
  revisions: [{ id: 'r1', root: '/vault', relPath: 'note.md', savedAt: 1, content: 'old text' }],
  entries: [
    { originalRelPath: 'first.md', trashRelPath: '.mesa-trash/100/first.md', isDirectory: false },
    { originalRelPath: 'second.md', trashRelPath: '.mesa-trash/100/second.md', isDirectory: false },
  ],
}));
// A small live store: setters update state and re-render subscribers, so a
// control's visible state proves its value really changed.
const live = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state: Record<string, unknown> = {};
  return {
    get: () => state,
    reset: (next: Record<string, unknown>) => { state = next; },
    patch: (next: Record<string, unknown>) => { state = { ...state, ...next }; listeners.forEach(l => l()); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
});
vi.mock('../store', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    THEMES: [
      { id: 'void', label: 'Void', blurb: '', swatch: ['#000', '#111'] },
      { id: 'paper', label: 'Paper', blurb: '', swatch: ['#fff', '#eee'] },
    ],
    UI_STYLES: [{ id: 'classic', label: 'Classic', blurb: '' }, { id: 'studio', label: 'Studio', blurb: '' }],
    getStore: () => live.get(),
    useAppStore: (select: (state: Record<string, unknown>) => unknown) =>
      useSyncExternalStore(live.subscribe, () => select({ ...live.get(), settingsSection: mocks.section, getVaultGeneration: () => mocks.generation })),
  };
});
function resetStore() {
  live.reset({
    settingsOpen: true, vaultPath: '/vault', activePath: 'note.md', revisionHistoryRequest: 0,
    listActiveTextRevisions: listRevisions, purgeTextRevision: mocks.purgeRevision, content: 'current text',
    theme: 'void', uiStyle: 'studio',
    settings: { hotkeys: {}, enableTabs: false, hoverDelayMs: 450, hardwareAccel: true, animations: true, sidebarAutoHide: false, sidebarOpen: false, hideGeneratedFiles: false, templatesFolder: 'Templates' },
    setSetting: vi.fn((key: string, value: unknown) => live.patch({ settings: { ...(live.get().settings as object), [key]: value } })),
    setTheme: vi.fn((theme: string) => live.patch({ theme })),
    setUiStyle: vi.fn((uiStyle: string) => live.patch({ uiStyle })),
    applyWorkspacePreset: vi.fn(),
    setSettingsOpen: vi.fn(),
  });
}
const listRevisions = async () => mocks.revisions;
vi.mock('../lib/confirmAction', () => ({ confirmAction: mocks.confirm }));
vi.mock('../lib/vault', () => ({ listRecoveryEntries: async () => mocks.entries, purgeRecoveryEntry: mocks.purge }));
vi.mock('./Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
import { SettingsModal } from './SettingsModal';
import { SettingsGroups } from './settings/SettingsGroups';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  resetStore(); mocks.generation = 1; mocks.purge.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<SettingsModal />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function click(label: string) { await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label)!.click()); }
it('requires the exact typed phrase before permanently deleting one item', async () => {
  await click('Permanently delete'); expect(mocks.purge).not.toHaveBeenCalled();
  await typePhrase('delete'); await click('Confirm permanent deletion'); expect(mocks.purge).not.toHaveBeenCalled();
  await typePhrase('DELETE'); await click('Confirm permanent deletion');
  expect(mocks.purge).toHaveBeenCalledExactlyOnceWith('/vault', mocks.entries[0]);
  expect(host.textContent).toContain('Permanently deleted 1 item.');
  expect(host.querySelectorAll('.recovery-row')).toHaveLength(1);
});
it('stops a bulk purge on failure and retains the failed item for recovery', async () => {
  mocks.purge.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk denied'));
  await click('Empty recovery storage'); await typePhrase('EMPTY'); await click('Confirm permanent deletion');
  expect(mocks.purge).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('Deleted 1 items; removal stopped: Error: disk denied');
  expect(host.querySelector('.recovery-row')?.textContent).toContain('second.md');
});
it('does not continue a bulk purge after the vault session changes', async () => {
  mocks.purge.mockImplementationOnce(async () => {
    mocks.generation++;
    await act(async () => root.render(<SettingsModal />));
  });
  await click('Empty recovery storage'); await typePhrase('EMPTY'); await click('Confirm permanent deletion');
  expect(mocks.purge).toHaveBeenCalledTimes(1);
});

async function typePhrase(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label^="Type "]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('Cancel retains recovery entries', async () => {
  await click('Permanently delete'); await typePhrase('DELETE'); await click('Cancel');
  expect(mocks.purge).not.toHaveBeenCalled();
  expect(host.querySelectorAll('.recovery-row')).toHaveLength(2);
});
it.each([true, false])('asks before permanently removing a local revision (confirmed: %s)', async (confirmed) => {
  await act(async () => root.unmount());
  mocks.section = 'history'; mocks.confirm.mockResolvedValueOnce(confirmed);
  root = createRoot(host);
  try {
    await act(async () => root.render(<SettingsModal />));
    await click('Remove');
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.confirm.mock.calls[0][0]).toMatch(/cannot be undone/);
    if (confirmed) {
      expect(mocks.purgeRevision).toHaveBeenCalledExactlyOnceWith('r1');
      expect(host.textContent).toContain('Revision removed.');
    } else {
      expect(mocks.purgeRevision).not.toHaveBeenCalled();
    }
  } finally { mocks.section = 'deleted'; mocks.purgeRevision.mockClear(); mocks.confirm.mockClear(); }
});


describe('grouped settings', () => {
  const state = () => live.get() as { settings: Record<string, unknown>; theme: string; uiStyle: string; setSetting: ReturnType<typeof vi.fn>; applyWorkspacePreset: ReturnType<typeof vi.fn> };
  const groupButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.settings-nav button'));
  const groupButton = (label: string) => groupButtons().find(b => b.textContent === label)!;
  const openGroup = (label: string) => act(async () => groupButton(label).click());
  const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const toggle = async (label: string) => { await act(async () => byLabel(label)!.click()); return byLabel(label)!.getAttribute('aria-checked'); };
  const expandMore = (label: string) => act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.settings-more-toggle')).find(b => b.textContent?.includes(label))!.click());
  async function rerender() {
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<SettingsModal />));
  }
  beforeEach(async () => { mocks.section = 'settings'; await rerender(); await openGroup('Appearance'); });
  afterEach(() => { mocks.section = 'deleted'; });

  it('shows exactly one open group, with its panel wired to its button', async () => {
    expect(groupButtons().map(b => b.textContent)).toEqual(['Appearance', 'Workspace', 'Files', 'Shortcuts', 'Updates']);
    for (const label of ['Workspace', 'Files', 'Shortcuts', 'Updates', 'Appearance']) {
      await openGroup(label);
      const expanded = groupButtons().filter(b => b.getAttribute('aria-expanded') === 'true');
      expect(expanded.map(b => b.textContent)).toEqual([label]);
      // Every button controls a real panel; only the open one is shown and has content.
      for (const b of groupButtons()) {
        const panel = document.getElementById(b.getAttribute('aria-controls')!)!;
        expect(panel.getAttribute('role')).toBe('region');
        expect(panel.getAttribute('aria-labelledby')).toBe(b.id);
        expect(panel.hidden).toBe(b !== expanded[0]);
        expect(panel.childElementCount > 0).toBe(b === expanded[0]);
        expect(b.type).toBe('button');
      }
    }
    const results = await axe.run(host, { runOnly: ['aria-valid-attr-value', 'aria-allowed-attr', 'button-name', 'aria-input-field-name', 'aria-toggle-field-name'] });
    expect(results.violations).toEqual([]);
  });

  it('moves between groups with arrow, Home and End keys and opens with a native button', async () => {
    const key = (k: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
    groupButton('Appearance').focus();
    await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Workspace');
    await key('End'); expect(document.activeElement?.textContent).toBe('Updates');
    await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Appearance');
    await key('ArrowUp'); expect(document.activeElement?.textContent).toBe('Updates');
    await key('Home'); expect(document.activeElement?.textContent).toBe('Appearance');
    await key('ArrowDown'); await key('ArrowDown');
    // Arrow keys only move focus; Enter or Space (a native button click) opens.
    expect(groupButton('Files').getAttribute('aria-expanded')).toBe('false');
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(groupButton('Files').getAttribute('aria-expanded')).toBe('true');
    expect(byLabel('Templates folder')).not.toBeNull();
  });

  it('keeps only the open group button in the Tab order', async () => {
    const tabStops = () => groupButtons().filter(b => b.tabIndex === 0).map(b => b.textContent);
    expect(tabStops()).toEqual(['Appearance']);
    expect(groupButtons().filter(b => b.tabIndex === -1)).toHaveLength(4);
    await openGroup('Shortcuts');
    expect(tabStops()).toEqual(['Shortcuts']);
    // The next Tab stop after the list is the first control of the open group.
    const order = Array.from(host.querySelectorAll<HTMLElement>('button, input')).filter(el => el.tabIndex >= 0 && !el.closest('[hidden]'));
    const listEnd = order.indexOf(groupButton('Shortcuts'));
    expect(order[listEnd + 1].closest('[role="region"]')?.getAttribute('data-settings-group')).toBe('shortcuts');
  });

  it('shows the Updates section passed in under the version', async () => {
    await act(async () => root.render(<SettingsGroups updates={<p>Updates section</p>} />));
    await openGroup('Updates');
    const panel = host.querySelector<HTMLElement>('[data-settings-group="updates"]')!;
    expect(panel.textContent).toContain('Version');
    expect(panel.textContent).toContain('Updates section');
    expect(panel.textContent!.indexOf('Version')).toBeLessThan(panel.textContent!.indexOf('Updates section'));
  });

  it('remembers the open group when Settings opens again', async () => {
    await openGroup('Files');
    await rerender();
    expect(groupButton('Files').getAttribute('aria-expanded')).toBe('true');
    expect(byLabel('Templates folder')).not.toBeNull();
  });

  it('does not mount the hotkey recorder or More options until opened', async () => {
    expect(host.querySelector('.hotkey-settings')).toBeNull();
    expect(host.querySelector('[data-hotkey-recorder]')).toBeNull();
    expect(byLabel('Layered overlays')).toBeNull();
    await openGroup('Workspace');
    expect(host.querySelector('.hotkey-settings')).toBeNull();
    expect(byLabel('Preview delay')).toBeNull();
    await openGroup('Shortcuts');
    expect(host.querySelector('.hotkey-settings')).not.toBeNull();
    await openGroup('Updates');
    expect(host.querySelector('.hotkey-settings')).toBeNull();
    expect(host.textContent).toContain('Version');
  });

  it('keeps every Appearance setting reachable and working', async () => {
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Theme"] button')).find(b => b.textContent === 'Paper')!.click());
    expect(state().theme).toBe('paper');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Interface style"] button')).find(b => b.textContent === 'Classic')!.click());
    expect(state().uiStyle).toBe('classic');
    const more = host.querySelector<HTMLButtonElement>('.settings-more-toggle')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(more.getAttribute('aria-controls')!)?.hidden).toBe(true);
    await expandMore('More appearance');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(await toggle('Interface animations')).toBe('false');
    expect(state().settings.animations).toBe(false);
    expect(await toggle('Layered overlays')).toBe('false');
    expect(state().settings.hardwareAccel).toBe(false);
  });

  it('keeps every Workspace setting reachable and working', async () => {
    await openGroup('Workspace');
    for (const preset of ['Write', 'Read', 'Research']) {
      await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Workspace layout"] button')).find(b => b.textContent === preset)!.click());
    }
    expect(state().applyWorkspacePreset.mock.calls).toEqual([['write'], ['read'], ['research']]);
    expect(await toggle('File tabs')).toBe('true');
    expect(state().settings.enableTabs).toBe(true);
    expect(await toggle('Auto-hide sidebar')).toBe('true');
    expect(state().settings).toMatchObject({ sidebarAutoHide: true, sidebarOpen: true });
    await expandMore('More workspace');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Preview delay"] button')).find(b => b.textContent === 'Long')!.click());
    expect(state().settings.hoverDelayMs).toBe(900);
    expect(host.querySelector('[aria-label="Preview delay"] [aria-pressed="true"]')?.textContent).toBe('Long');
  });

  it('keeps every Files setting reachable and working', async () => {
    await openGroup('Files');
    expect(await toggle('Hide generated files')).toBe('true');
    expect(state().settings.hideGeneratedFiles).toBe(true);
    const input = byLabel('Templates folder') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Blueprints');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(state().settings.templatesFolder).toBe('Blueprints');
    expect((byLabel('Templates folder') as HTMLInputElement).value).toBe('Blueprints');
  });

  it('keeps hotkey assignment reachable and working under Shortcuts', async () => {
    await openGroup('Shortcuts');
    expect(host.querySelector('.hotkey-settings .setting-name')?.textContent).toBe('Shortcuts');
    const set = byLabel('Set shortcut for New note')!;
    await act(async () => set.click());
    const recorder = host.querySelector<HTMLButtonElement>('[data-hotkey-recorder]')!;
    await act(async () => { recorder.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true })); });
    expect(state().settings.hotkeys).toEqual({ new: 'F8' });
    await act(async () => byLabel('Clear shortcut for New note')!.click());
    expect(state().settings.hotkeys).toEqual({});
  });
});
