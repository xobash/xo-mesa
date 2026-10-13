// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  generation: 1,
  purge: vi.fn(),
  entries: [
    { originalRelPath: 'first.md', trashRelPath: '.mesa-trash/100/first.md', isDirectory: false },
    { originalRelPath: 'second.md', trashRelPath: '.mesa-trash/100/second.md', isDirectory: false },
  ],
}));
vi.mock('../store', () => ({ THEMES: [], useAppStore: (select: (state: unknown) => unknown) => select({
  settingsSection: 'deleted', settingsOpen: true, settings: {}, vaultPath: '/vault', activePath: 'note.md',
  revisionHistoryRequest: 0, getVaultGeneration: () => mocks.generation,
}) }));
vi.mock('../lib/vault', () => ({ listRecoveryEntries: async () => mocks.entries, purgeRecoveryEntry: mocks.purge }));
vi.mock('./Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
import { SettingsModal } from './SettingsModal';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  mocks.generation = 1; mocks.purge.mockReset().mockResolvedValue(undefined);
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
