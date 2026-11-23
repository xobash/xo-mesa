// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildPackage, docxParts } from '../lib/ooxml/fixtures/ooxmlFixtures';
import type { WordSurface } from './wordEngine';
import type { WordSurfaceFactory } from './useWordDocument';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(async (_job: { path: string; bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => undefined),
  writeCopy: vi.fn(async (_root: string, _rel: string, _bytes: Uint8Array, _options: { expectedMissing?: boolean }) => undefined),
  register: vi.fn(async (_rel: string) => undefined),
  confirm: vi.fn(async () => true),
  file: { path: '/v/Report.docx', relPath: 'Report.docx', name: 'Report', ext: 'docx', mtime: 1 } as Record<string, unknown>,
}));
vi.mock('../store', () => {
  const state = () => ({ fileFor: () => io.file, files: [io.file], vaultPath: '/v', registerVaultFile: io.register, openDocWindow: vi.fn(), activePath: null, revealActiveFile: vi.fn() });
  return { useAppStore: (select: (s: Record<string, unknown>) => unknown) => select(state()), getStore: state };
});
vi.mock('../lib/confirmAction', () => ({ confirmAction: io.confirm }));
vi.mock('../lib/documentBytesSave', () => ({
  readDocumentBytes: io.read,
  saveDocumentBytes: io.save,
  DocumentChangedOnDiskError: class extends Error {},
}));
vi.mock('../lib/vault', async (original) => ({ ...(await original<typeof import('../lib/vault')>()), IN_TAURI: true, writeVaultBinaryFile: io.writeCopy }));
vi.mock('../lib/vaultByteRead', () => ({
  readVaultRange: async (_file: unknown, offset: number, len: number) => {
    const data: Uint8Array = await io.read();
    return { bytes: data.subarray(offset, offset + len), size: data.length, stamp: 's1' };
  },
}));
import { WordView } from './WordView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const STYLES = '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Normal"/></w:styles>';
const REWRITTEN = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Normal"></w:style></w:styles>';
const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = (body: string, styles = STYLES, extra: Record<string, string> = {}) =>
  buildPackage(docxParts(body, { 'word/styles.xml': styles, ...extra }, { 'word/styles.xml': STYLES_TYPE }, [{ id: 'rIdS', type: 'styles', target: 'styles.xml' }]));
const partText = (bytes: Uint8Array, name: string) => new TextDecoder().decode(unzipSync(bytes)[name]);

/** Stand-in for the layout engine: serializes `output()` and reports edits through its events. */
function fakeEngine(output: () => Uint8Array) {
  const calls: string[] = [];
  let events: Parameters<WordSurfaceFactory>[2] | null = null;
  let mounted: Uint8Array | null = null;
  const surface: WordSurface = {
    setEditing: (on) => { calls.push(on ? 'edit' : 'view'); return null; },
    save: async () => { calls.push('save'); return output(); },
    run: (command) => { calls.push(command.type); return null; },
    insertImage: async () => null,
    formatting: () => ({ bold: false, italic: false, underline: false, strike: false, alignment: null, inTable: false, canUndo: true, canRedo: false }),
    destroy: () => { calls.push('destroy'); },
  };
  const mount: WordSurfaceFactory = async (_host, bytes, e) => { mounted = bytes; events = e; calls.push('mount'); return surface; };
  return { calls, mount, edit: () => events!.onChange(), mountedBytes: () => mounted };
}

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const onDirty = vi.fn();
const ORIGINAL = docx(para('Hello'));

beforeEach(() => {
  io.file = { path: '/v/Report.docx', relPath: 'Report.docx', name: 'Report', ext: 'docx', mtime: 1 };
  io.read.mockResolvedValue(ORIGINAL);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
async function mount(engine: ReturnType<typeof fakeEngine>, editable = true) {
  await act(async () => root.render(<WordView rel="Report.docx" editable={editable} onDirtyChange={onDirty} mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(engine.calls).toContain('mount'));
}
async function click(label: string) {
  await act(async () => button(label)!.click());
}

it('opens read-only first and records the no-edit output before unlocking', async () => {
  const engine = fakeEngine(() => docx(para('Hello'), REWRITTEN));
  await mount(engine);
  expect(host.textContent).toContain('Read-only');
  expect(button('Save')).toBeUndefined();
  expect(button('Bold')).toBeUndefined();
  expect(engine.mountedBytes()).toEqual(ORIGINAL);
  await click('Edit');
  expect(engine.calls.slice(1)).toEqual(['save', 'edit']);
  expect(host.textContent).toContain('Editing, no changes');
  expect(button('Save')!.disabled).toBe(true);
});

it('saves only the changed part over the opened bytes and keeps every other part byte-for-byte', async () => {
  let current = docx(para('Hello'), REWRITTEN);
  const engine = fakeEngine(() => current);
  await mount(engine);
  await click('Edit');
  current = docx(para('Hello world'), REWRITTEN);
  await act(async () => engine.edit());
  expect(host.textContent).toContain('Unsaved changes');
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await click('Save');
  expect(io.save).toHaveBeenCalledOnce();
  const job = io.save.mock.calls[0][0];
  expect(job.path).toBe('/v/Report.docx');
  expect(job.expected).toEqual(ORIGINAL);
  expect(partText(job.bytes, 'word/styles.xml')).toBe(STYLES);
  expect(partText(job.bytes, 'word/document.xml')).toContain('Hello world');
  expect(() => job.validate!(job.bytes)).not.toThrow();
  await vi.waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  expect(host.textContent).toContain('Saved.');
});

it('writes nothing when the edits return the document to its opened state', async () => {
  const engine = fakeEngine(() => docx(para('Hello'), REWRITTEN));
  await mount(engine);
  await click('Edit');
  await act(async () => engine.edit());
  await click('Save');
  expect(io.save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('No changes to save.');
  expect(onDirty).toHaveBeenLastCalledWith(false);
});

it('refuses a save that would break a reference and keeps the edits', async () => {
  let current = docx(para('Hello'), REWRITTEN);
  const engine = fakeEngine(() => current);
  await mount(engine);
  await click('Edit');
  current = docx('<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId404"/></w:drawing></w:r></w:p>', REWRITTEN);
  await act(async () => engine.edit());
  await click('Save');
  expect(io.save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Not saved: the result would damage the file');
  expect(host.textContent).toContain('Unsaved changes');
});

it('asks before a save removes bookmarks and writes nothing when the user keeps editing', async () => {
  const marked = '<w:p><w:bookmarkStart w:id="0" w:name="b"/><w:r><w:t>Hello</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>';
  io.read.mockResolvedValue(docx(marked));
  let current = docx(marked, REWRITTEN);
  const engine = fakeEngine(() => current);
  await mount(engine);
  await click('Edit');
  current = docx(para('Hello'), REWRITTEN);
  await act(async () => engine.edit());
  io.confirm.mockResolvedValueOnce(false);
  await click('Save');
  expect(io.confirm).toHaveBeenCalledWith(expect.stringContaining('bookmarks: 1 → 0'), expect.anything());
  expect(io.save).not.toHaveBeenCalled();
});

it('saves in place around tracked changes, and names the paragraph when an edit touches one', async () => {
  const tracked = '<w:p><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>Hello</w:t></w:r></w:ins></w:p>';
  const engineTracked = '<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>Hello</w:t></w:r></w:ins></w:p>';
  io.read.mockResolvedValue(docx(tracked));
  let current = docx(engineTracked, REWRITTEN);
  const engine = fakeEngine(() => current);
  await mount(engine);
  expect(host.textContent).toContain('Mesa saves edits only in paragraphs without them');
  await click('Edit');
  current = docx(engineTracked + para('More'), REWRITTEN);
  await act(async () => engine.edit());
  expect(button('Save')!.disabled).toBe(false);
  await click('Save');
  expect(io.save).toHaveBeenCalledOnce();
  const saved = partText(io.save.mock.calls[0][0].bytes, 'word/document.xml');
  expect(saved).toContain(tracked);
  expect(saved).toContain('More');

  current = docx(engineTracked.replace('Hello', 'Hi') + para('More'), REWRITTEN);
  await act(async () => engine.edit());
  await click('Save');
  expect(io.save).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Not saved: paragraph 1 of the main text (“Hello”) has tracked changes');
  await click('Save as copy');
  expect(io.writeCopy).toHaveBeenCalledOnce();
  const [root, rel, bytes, options] = io.writeCopy.mock.calls[0];
  expect([root, rel, options]).toEqual(['/v', 'Report copy.docx', { expectedMissing: true }]);
  expect(partText(bytes, 'word/document.xml')).toContain('Hi');
  expect(io.register).toHaveBeenCalledWith('Report copy.docx');
});

it('keeps edits and blocks Save when the file changes on disk while dirty', async () => {
  let current = docx(para('Hello'), REWRITTEN);
  const engine = fakeEngine(() => current);
  await mount(engine);
  await click('Edit');
  current = docx(para('Mine'), REWRITTEN);
  await act(async () => engine.edit());
  io.read.mockResolvedValue(docx(para('Theirs')));
  io.file = { ...io.file, mtime: 2 };
  await act(async () => root.render(<WordView rel="Report.docx" editable onDirtyChange={onDirty} mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(host.textContent).toContain('changed on disk'));
  expect(engine.calls.filter((c) => c === 'mount')).toHaveLength(1);
  expect(button('Save')!.disabled).toBe(true);
  expect(button('Save as copy')!.disabled).toBe(false);
});

it('shows legacy or encrypted Office files in the details view with the reason', async () => {
  io.read.mockResolvedValue(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
  const engine = fakeEngine(() => new Uint8Array());
  await act(async () => root.render(<WordView rel="Report.docx" editable mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(host.textContent).toContain('encrypted or in the legacy binary Office format'));
  expect(engine.calls).not.toContain('mount');
  expect(host.querySelector('.file-details')).not.toBeNull();
});

it('stays view-only where the surface has no unsaved-edit guard', async () => {
  const engine = fakeEngine(() => ORIGINAL);
  await mount(engine, false);
  expect(button('Edit')).toBeUndefined();
  expect(engine.calls).not.toContain('edit');
});

it('reports a picture whose bytes cannot be read instead of leaving the read unhandled', async () => {
  const engine = fakeEngine(() => docx(para('Hello'), REWRITTEN));
  await mount(engine);
  await click('Edit');
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const picked = { size: 10, arrayBuffer: () => Promise.reject(new Error('the file went away')) };
  Object.defineProperty(input, 'files', { configurable: true, value: [picked] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await vi.waitFor(() => expect(host.textContent).toContain('The picture could not be read: the file went away'));
});

it('does not block the next Save when the watcher reports Mesa\'s own write before the save finishes', async () => {
  let current = docx(para('Hello'), REWRITTEN);
  const engine = fakeEngine(() => current);
  await mount(engine);
  await click('Edit');
  current = docx(para('Hello world'), REWRITTEN);
  await act(async () => engine.edit());
  let release!: () => void;
  io.save.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
  await click('Save');
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledOnce());
  io.read.mockResolvedValue(io.save.mock.calls[0][0].bytes);
  io.file = { ...io.file, mtime: 2 };
  await act(async () => root.render(<WordView rel="Report.docx" editable onDirtyChange={onDirty} mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(host.textContent).toContain('changed on disk'));
  await act(async () => { release(); });
  await vi.waitFor(() => expect(host.textContent).toContain('Saved.'));
  current = docx(para('Hello again'), REWRITTEN);
  await act(async () => engine.edit());
  await click('Save');
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledTimes(2));
});
