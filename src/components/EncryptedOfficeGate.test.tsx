// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildPackage, docxParts } from '../lib/ooxml/fixtures/ooxmlFixtures';
import { writeCfb } from '../lib/cfb';
import { decryptOfficeFile, encryptOfficeFile } from '../lib/officeCrypto/encryptedOffice';
import { base64ToBytes } from '../lib/officeCrypto/primitives';
import { agileSha1Vector, standardVector } from '../lib/officeCrypto/fixtures/referenceVectors';
import type { WordSurface } from './wordEngine';
import type { WordSurfaceFactory } from './useWordDocument';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(async (_job: { path: string; bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => undefined),
  writeCopy: vi.fn(async (_root: string, _rel: string, _bytes: Uint8Array, _options: { expectedMissing?: boolean }) => undefined),
  register: vi.fn(async (_rel: string) => undefined),
  file: { path: '/v/Secret.docx', relPath: 'Secret.docx', name: 'Secret', ext: 'docx', mtime: 1 } as Record<string, unknown>,
}));
vi.mock('../store', () => {
  const state = () => ({ fileFor: () => io.file, files: [io.file], vaultPath: '/v', registerVaultFile: io.register, openDocWindow: vi.fn(), activePath: null, revealActiveFile: vi.fn() });
  return { useAppStore: (select: (s: Record<string, unknown>) => unknown) => select(state()), getStore: state };
});
vi.mock('../lib/confirmAction', () => ({ confirmAction: async () => true }));
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

const PASSWORD = 'Correct horse';
const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = (body: string) => buildPackage(docxParts(body));
const PLAIN = docx(para('Hello'));
const EDITED = docx(para('Hello world'));
const TEMPLATE = writeCfb([
  { path: 'EncryptionInfo', bytes: base64ToBytes(agileSha1Vector.info) },
  { path: 'EncryptedPackage', bytes: base64ToBytes(agileSha1Vector.package) },
]);
let ENCRYPTED: Uint8Array;

function fakeEngine(output: () => Uint8Array) {
  const calls: string[] = [];
  let events: Parameters<WordSurfaceFactory>[2] | null = null;
  let mounted: Uint8Array | null = null;
  const surface: WordSurface = {
    setEditing: (on) => { calls.push(on ? 'edit' : 'view'); return null; },
    save: async () => output(),
    run: () => null,
    insertImage: async () => null,
    formatting: () => ({ bold: false, italic: false, underline: false, strike: false, alignment: null, inTable: false, canUndo: true, canRedo: false }),
    destroy: () => { calls.push('destroy'); },
  };
  const mount: WordSurfaceFactory = async (_host, bytes, e) => { mounted = bytes; events = e; calls.push('mount'); return surface; };
  return { calls, mount, edit: () => events!.onChange(), mountedBytes: () => mounted };
}

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeAll(async () => { ENCRYPTED = await encryptOfficeFile(TEMPLATE, PLAIN, PASSWORD); });
beforeEach(() => {
  io.read.mockResolvedValue(ENCRYPTED);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
const passwordInput = () => document.querySelector<HTMLInputElement>('input[type="password"]');
async function typePassword(value: string) {
  const input = passwordInput()!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Open')!.click());
}

it('asks for the password, refuses a wrong one, then shows the decrypted document', async () => {
  const engine = fakeEngine(() => PLAIN);
  await act(async () => root.render(<WordView rel="Secret.docx" editable mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(passwordInput()).not.toBeNull());
  expect(document.body.textContent).toContain('This file is password-protected');
  expect(engine.calls).not.toContain('mount');

  await typePassword('wrong');
  await vi.waitFor(() => expect(document.body.textContent).toContain('That password is not correct'));
  expect(passwordInput()!.value).toBe('');
  expect(engine.calls).not.toContain('mount');

  await typePassword(PASSWORD);
  await vi.waitFor(() => expect(engine.calls).toContain('mount'));
  expect(engine.mountedBytes()).toEqual(PLAIN);
  expect(passwordInput()).toBeNull();
  expect(host.textContent).toContain('Password-protected');
  // The notice and the document share one column: side by side in the media
  // row, the view was squeezed and its Save button pushed out of reach.
  const column = host.querySelector('.office-gate');
  expect(column?.querySelector('.word-notice')).not.toBeNull();
  expect(column?.children.length).toBe(2);
});

it('writes the edit encrypted, with the encrypted bytes as precondition, and never the plain package', async () => {
  let output = PLAIN;
  const engine = fakeEngine(() => output);
  await act(async () => root.render(<WordView rel="Secret.docx" editable mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(passwordInput()).not.toBeNull());
  await typePassword(PASSWORD);
  await vi.waitFor(() => expect(engine.calls).toContain('mount'));
  await act(async () => button('Edit')!.click());
  await vi.waitFor(() => expect(engine.calls).toContain('edit'));
  output = EDITED;
  await act(async () => engine.edit());
  await act(async () => button('Save')!.click());
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledOnce(), { timeout: 10_000 });
  const job = io.save.mock.calls[0][0];
  expect(job.path).toBe('/v/Secret.docx');
  expect(job.expected).toEqual(ENCRYPTED);
  expect(job.bytes[0]).toBe(0xd0); // a compound file, not a ZIP
  const decrypted = await decryptOfficeFile(job.bytes, PASSWORD);
  expect(new TextDecoder().decode(decrypted)).toContain('word/document.xml');
  expect(() => job.validate!(job.bytes)).not.toThrow();
  await vi.waitFor(() => expect(host.textContent).toContain('Saved.'));

  // The save echo (the new encrypted bytes on disk) is recognised: no reload, no prompt.
  io.read.mockResolvedValue(job.bytes);
  io.file = { ...io.file, mtime: 2 };
  await act(async () => root.render(<WordView rel="Secret.docx" editable mountSurface={engine.mount} />));
  expect(passwordInput()).toBeNull();
}, 20_000);

it('saves a copy encrypted with the same password', async () => {
  let output = PLAIN;
  const engine = fakeEngine(() => output);
  await act(async () => root.render(<WordView rel="Secret.docx" editable mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(passwordInput()).not.toBeNull());
  await typePassword(PASSWORD);
  await vi.waitFor(() => expect(engine.calls).toContain('mount'));
  await act(async () => button('Edit')!.click());
  await vi.waitFor(() => expect(engine.calls).toContain('edit'));
  output = EDITED;
  await act(async () => engine.edit());
  await act(async () => button('Save as copy')!.click());
  await vi.waitFor(() => expect(io.writeCopy).toHaveBeenCalledOnce(), { timeout: 10_000 });
  const written = io.writeCopy.mock.calls[0][2];
  expect(written[0]).toBe(0xd0);
  expect(new TextDecoder().decode(await decryptOfficeFile(written, PASSWORD))).toContain('word/document.xml');
}, 20_000);

it('cancelling shows the details view with a way back to the prompt', async () => {
  const engine = fakeEngine(() => PLAIN);
  await act(async () => root.render(<WordView rel="Secret.docx" editable mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(passwordInput()).not.toBeNull());
  await act(async () => button('Cancel')!.click());
  expect(passwordInput()).toBeNull();
  expect(host.querySelector('.file-details')).not.toBeNull();
  expect(host.textContent).toContain('password-protected');
  // A correctly named encrypted .docx is not mislabelled and needs no re-save.
  await vi.waitFor(() => expect(host.querySelector('.file-details-hint')).not.toBeNull());
  expect(host.textContent).not.toMatch(/mislabell|save it from Office|Rename it/);
  await act(async () => button('Enter password')!.click());
  expect(passwordInput()).not.toBeNull();
});

it('opens Standard-encrypted files read-only', async () => {
  io.read.mockResolvedValue(writeCfb([
    { path: 'EncryptionInfo', bytes: base64ToBytes(standardVector.info) },
    { path: 'EncryptedPackage', bytes: base64ToBytes(standardVector.package) },
  ]));
  const engine = fakeEngine(() => PLAIN);
  await act(async () => root.render(<WordView rel="Secret.docx" editable mountSurface={engine.mount} />));
  await vi.waitFor(() => expect(passwordInput()).not.toBeNull());
  await typePassword('Password1234_');
  // The vector's plaintext is not a Word package, so the view explains it; it never offers Edit.
  await vi.waitFor(() => expect(passwordInput()).toBeNull(), { timeout: 20_000 });
  await vi.waitFor(() => expect(host.textContent).toMatch(/Standard encryption/));
  expect(button('Edit')).toBeUndefined();
}, 30_000);
