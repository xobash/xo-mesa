// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VaultFile, NoteMeta } from './types';

const io = vi.hoisted(() => ({
  scan: vi.fn(), read: vi.fn(), write: vi.fn(), index: vi.fn(), watch: vi.fn(), history: vi.fn(),
}));
vi.mock('./lib/vault', async original => ({
  ...await original<object>(),
  assertVaultRootAvailable: async () => {},
  scanVault: io.scan,
  readNoteResult: io.read,
  writeNote: io.write,
  watchVault: io.watch,
  recoverWriteArtifacts: async () => ({ restored: [], removed: [] }),
}));
vi.mock('./lib/textRevisionHistory', async original => ({ ...await original<object>(), recordTextRevisionsAsync: io.history }));
vi.mock('./lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: io.index }));
import { useAppStore } from './store';
import { localISO } from './lib/daily';

const initial = useAppStore.getState();
const file = (root: string, relPath: string): VaultFile => ({
  path: `${root}/${relPath}`, relPath, name: relPath.split('/').pop()!.replace(/\.md$/, ''),
  ext: relPath.split('.').pop()!, isMarkdown: relPath.endsWith('.md'),
});
const meta = (relPath: string, title: string, aliases: string[] = []): NoteMeta => ({
  relPath, title, rawLinks: [], tags: [], aliases, firstImagePath: undefined,
});
const TEXT: Record<string, string> = {
  'Alpha.md': '# Alpha\n',
  'Notes/Daily log.md': 'Met with alpha team today.\n',
  'Templates/Meeting.md': '# {{title}}\n\nDate: {{date}} at {{time}}\n',
};

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(initial);
  io.scan.mockImplementation(async (root: string) => Object.keys(TEXT).map((rel) => file(root, rel)));
  io.read.mockImplementation(async (target: VaultFile) => ({ ok: true, text: TEXT[target.relPath] }));
  io.write.mockResolvedValue(undefined);
  io.watch.mockResolvedValue(() => {});
  io.history.mockImplementation(async (_root, items) => items.map(() => ({ id: 'revision' })));
  io.index.mockResolvedValue({
    notes: {
      'Alpha.md': meta('Alpha.md', 'Alpha'),
      'Notes/Daily log.md': meta('Notes/Daily log.md', 'Daily log'),
      'Templates/Meeting.md': meta('Templates/Meeting.md', 'Meeting'),
    },
    cache: { ...TEXT }, reused: 0, read: 3, skipped: [], failed: [], changed: new Map(),
  });
});
afterEach(async () => { await useAppStore.getState().flushSave(); useAppStore.setState(initial); });

async function openVault() {
  await useAppStore.getState().openVault('/vault');
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
}

it('links an unlinked mention with a verified write against the current text', async () => {
  await openVault();
  const linked = await useAppStore.getState().linkUnlinkedMention(
    'Notes/Daily log.md', { start: 9, end: 14, text: 'alpha' }, 'Alpha.md');
  expect(linked).toBe(true);
  expect(io.write).toHaveBeenCalledWith(
    expect.objectContaining({ relPath: 'Notes/Daily log.md' }),
    'Met with [[Alpha|alpha]] team today.\n',
    'Met with alpha team today.\n');
  expect(useAppStore.getState().contentCache['Notes/Daily log.md']).toBe('Met with [[Alpha|alpha]] team today.\n');
});

it('refuses a stale mention without writing', async () => {
  await openVault();
  const linked = await useAppStore.getState().linkUnlinkedMention(
    'Notes/Daily log.md', { start: 0, end: 5, text: 'alpha' }, 'Alpha.md');
  expect(linked).toBe(false);
  expect(io.write).not.toHaveBeenCalled();
  expect(useAppStore.getState().status).toMatch(/changed; refresh unlinked mentions/);
});

it('reports a failed write instead of claiming the link', async () => {
  await openVault();
  io.write.mockRejectedValueOnce(new Error('disk full'));
  const linked = await useAppStore.getState().linkUnlinkedMention(
    'Notes/Daily log.md', { start: 9, end: 14, text: 'alpha' }, 'Alpha.md');
  expect(linked).toBe(false);
});

it('fills template placeholders for the active note', async () => {
  await openVault();
  await useAppStore.getState().selectFile('Alpha.md');
  const text = await useAppStore.getState().renderTemplate('Templates/Meeting.md');
  expect(text).toMatch(new RegExp(`^# Alpha\\n\\nDate: ${localISO()} at \\d\\d:\\d\\d\\n$`));
  expect(await useAppStore.getState().renderTemplate('Templates/Missing.md')).toBeNull();
});
