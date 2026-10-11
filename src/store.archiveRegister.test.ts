// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn(async () => '<p>archived</p>'), scan: vi.fn(async () => []) }));
vi.mock('./lib/vault', async original => ({ ...await original<object>(), readNote: io.read, scanVault: io.scan }));
import { useAppStore } from './store';
const initial = useAppStore.getState();
afterEach(() => { useAppStore.setState(initial, true); vi.clearAllMocks(); });
it('registers one saved page while preserving tabs, selection and the running research object', async () => {
  const research = { runId: 'archive-run', phase: 'researching' } as NonNullable<typeof initial.deepResearch>;
  useAppStore.setState({ vaultPath: '/vault', files: [], notes: {}, contentCache: {}, openTabs: ['a.md'], activePath: 'a.md', deepResearch: research });
  await useAppStore.getState().registerVaultFile('Web/page.html');
  expect(useAppStore.getState().openTabs).toEqual(['a.md']);
  expect(useAppStore.getState().activePath).toBe('a.md');
  expect(useAppStore.getState().deepResearch).toBe(research);
  expect(useAppStore.getState().fileFor('Web/page.html')).toBeDefined();
  expect(io.read).toHaveBeenCalledOnce(); expect(io.scan).not.toHaveBeenCalled();
});
it('does not register a stale archive after the vault changes during its read', async () => {
  let finish!: (text: string) => void;
  io.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useAppStore.setState({ vaultPath: '/vault', files: [], notes: {}, contentCache: {} });
  const pending = useAppStore.getState().registerVaultFile('Web/page.html');
  useAppStore.setState({ vaultPath: '/other' }); finish('old'); await pending;
  expect(useAppStore.getState().fileFor('Web/page.html')).toBeUndefined();
});
