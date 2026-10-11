// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { VaultFile } from '../types';
const mock = vi.hoisted(() => ({
  invoke: vi.fn(), undo: vi.fn(), redo: vi.fn(), dirty: false,
  bytes: new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
vi.mock('../lib/vault', () => ({ IN_TAURI: true, urlForPath: (path: string) => `asset://${path}` }));
vi.mock('../store', () => ({ useAppStore: (fn: (state: unknown) => unknown) => fn({ fileFor: () => undefined }) }));
vi.mock('./usePdfEditor', () => ({ usePdfEditor: () => ({
  bytes: mock.bytes,
  pageCount: 1, scale: 1, renderScale: 1, setScale: vi.fn(), dirty: mock.dirty,
  status: '', renderError: 'Rendering failed', loadFailed: false, fields: [], textRuns: [],
  firstPagePainted: false, viewports: { current: new Map() }, canvasRefs: { current: new Map() },
  pageSizes: new Map(), bindCanvas: vi.fn(), setOnscreenPages: vi.fn(),
  undo: mock.undo, redo: mock.redo, canUndo: true, canRedo: true,
}) }));
import { PdfView } from './PdfView';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllGlobals(); mock.invoke.mockReset(); mock.undo.mockReset(); mock.redo.mockReset();
  mock.dirty = false;
  mock.bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
});
const file: VaultFile = { path: '/vault/sample.pdf', relPath: 'sample.pdf', name: 'sample', ext: 'pdf', isMarkdown: false };

it('waits for native PDF admission and revokes on unmount', async () => {
  const blob = 'blob:http://tauri.localhost/00000000-0000-0000-0000-000000000000';
  const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => blob); static revokeObjectURL = revoke; });
  let approve!: () => void;
  mock.invoke.mockImplementation((_command, args) => args.allow ? new Promise<void>(resolve => { approve = resolve; }) : Promise.resolve());
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PdfView rel="sample.pdf" file={file} />));
  expect(host.querySelector('iframe')).toBeNull();
  expect(mock.invoke).toHaveBeenCalledWith('navigation_pdf_preview', { url: blob, allow: true });
  await act(async () => { approve(); });
  expect(host.querySelector('iframe')?.getAttribute('src')).toBe(blob);
  await act(async () => root.unmount());
  expect(mock.invoke).toHaveBeenCalledWith('navigation_pdf_preview', { url: blob, allow: false });
  expect(revoke).toHaveBeenCalledWith(blob);
  host.remove();
});

it('shows admission errors without loading a fresh disk copy', async () => {
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:http://tauri.localhost/test'); static revokeObjectURL = vi.fn(); });
  mock.invoke.mockRejectedValue('PDF preview denied');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PdfView rel="sample.pdf" file={file} />));
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[role=alert]')?.textContent).toContain('PDF preview denied');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('revokes approval that arrives after the viewer unmounts', async () => {
  const blob = 'blob:http://tauri.localhost/00000000-0000-0000-0000-000000000000';
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => blob); static revokeObjectURL = vi.fn(); });
  let approve!: () => void;
  mock.invoke.mockImplementation((_command, args) => args.allow ? new Promise<void>(resolve => { approve = resolve; }) : Promise.resolve());
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PdfView rel="sample.pdf" file={file} />));
  await act(async () => root.unmount());
  await act(async () => { approve(); });
  expect(mock.invoke).toHaveBeenLastCalledWith('navigation_pdf_preview', { url: blob, allow: false });
  expect(host.querySelector('iframe')).toBeNull();
  host.remove();
});

it('revokes the previous byte snapshot and waits for replacement admission', async () => {
  const urls = [0, 1].map(value => `blob:http://tauri.localhost/${value}0000000-0000-0000-0000-000000000000`);
  const create = vi.fn().mockReturnValueOnce(urls[0]).mockReturnValueOnce(urls[1]);
  const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const approvals: (() => void)[] = [];
  mock.invoke.mockImplementation((_command, args) => args.allow ? new Promise<void>(resolve => approvals.push(resolve)) : Promise.resolve());
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PdfView rel="sample.pdf" file={file} />));
    await act(async () => approvals[0]());
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(urls[0]);
    mock.bytes = new TextEncoder().encode('%PDF-1.7\n2 0 obj\n<<>>\nendobj\n%%EOF');
    await act(async () => root.render(<PdfView rel="sample.pdf" file={file} />));
    expect(host.querySelector('iframe')).toBeNull();
    expect(mock.invoke).toHaveBeenCalledWith('navigation_pdf_preview', { url: urls[0], allow: false });
    expect(revoke).toHaveBeenCalledWith(urls[0]);
    await act(async () => approvals[1]());
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(urls[1]);
    expect(create.mock.calls.map(([blob]) => blob.type)).toEqual(['application/pdf', 'application/pdf']);
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(mock.invoke).toHaveBeenCalledWith('navigation_pdf_preview', { url: urls[1], allow: false });
  expect(revoke).toHaveBeenCalledWith(urls[1]);
});

it('keeps dirty-window reporting and owned undo shortcuts during a render fallback', async () => {
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:http://tauri.localhost/00000000-0000-0000-0000-000000000000'); static revokeObjectURL = vi.fn(); });
  mock.invoke.mockResolvedValue(undefined);
  mock.dirty = true;
  const onDirtyChange = vi.fn();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PdfView rel="sample.pdf" file={file} onDirtyChange={onDirtyChange} />));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Annotate, highlight, fill forms, reorder pages"]')!.click());
    const editor = host.querySelector<HTMLElement>('.pdf-editor')!;
    editor.focus();
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
      await act(async () => editor.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(mock.undo).toHaveBeenCalledTimes(1);
    expect(mock.redo).toHaveBeenCalledTimes(1);
    const input = document.createElement('input'); editor.append(input); input.focus();
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    expect(mock.undo).toHaveBeenCalledTimes(1);
    input.remove();
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Back to read-only viewing"]')!.click());
    expect(host.querySelector('iframe')).not.toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});
