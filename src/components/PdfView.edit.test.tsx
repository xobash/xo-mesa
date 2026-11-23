// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VaultFile } from '../types';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const mock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  apply: vi.fn(), save: vi.fn(), undo: vi.fn(), redo: vi.fn(), setScale: vi.fn(), setOnscreenPages: vi.fn(),
  viewports: new Map<number, unknown>(), canvases: new Map<number, HTMLCanvasElement>(),
  edit: {} as Record<string, ReturnType<typeof vi.fn>>,
  storeFile: undefined as unknown,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('../lib/vault', () => ({ IN_TAURI: false }));
vi.mock('../store', () => ({ useAppStore: (fn: (state: unknown) => unknown) => fn({ fileFor: () => mock.storeFile }) }));
vi.mock('../lib/pdfEditModule', () => ({ loadPdfEditModule: async () => mock.edit }));
vi.mock('./usePdfEditor', () => ({ usePdfEditor: () => ({
  bytes: PDF, pageCount: 1, scale: 1, renderScale: 1, setScale: mock.setScale, dirty: false,
  status: '', renderError: '', apply: mock.apply, save: mock.save, loadFailed: false, fields: [], textRuns: [],
  firstPagePainted: false, viewports: { current: mock.viewports }, canvasRefs: { current: mock.canvases },
  pageSizes: new Map(), pageSizeVersion: 0, bindCanvas: () => () => {}, setOnscreenPages: mock.setOnscreenPages,
  perfRunId: null, undo: mock.undo, redo: mock.redo, canUndo: true, canRedo: true,
  ...mock.state,
}) }));
import { PdfView } from './PdfView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const file: VaultFile = { path: '/vault/sample.pdf', relPath: 'sample.pdf', name: 'sample', ext: 'pdf', isMarkdown: false };
const CURRENT = new Uint8Array([1, 2, 3]);
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mock.state = {};
  for (const name of ['addText', 'replaceText', 'addInkStroke', 'addHighlight', 'addBlankPage', 'rotatePage', 'movePage', 'deletePage', 'setFormField']) {
    mock.edit[name] = vi.fn(() => `${name}-result`);
  }
  mock.storeFile = undefined;
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:x'); static revokeObjectURL = vi.fn(); });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const fn of [mock.apply, mock.save, mock.undo, mock.redo, mock.setScale, mock.setOnscreenPages]) fn.mockReset();
  mock.viewports.clear(); mock.canvases.clear();
});

const byTitle = (title: string) => host.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
const allByTitle = (title: string) => [...host.querySelectorAll<HTMLButtonElement>(`button[title="${title}"]`)];
async function render(props: Partial<Parameters<typeof PdfView>[0]> = {}) {
  await act(async () => root.render(<PdfView rel="sample.pdf" file={file} {...props} />));
}
async function enterEdit() {
  await act(async () => byTitle('Annotate, highlight, fill forms, reorder pages').click());
}
/** Runs the edit the view queued and reports which pdf-lib operation it called. */
async function runApplied(index: number) {
  const [edit, options] = mock.apply.mock.calls[index];
  const result = await edit(CURRENT);
  return { result, options };
}
function pageCanvas(page = 0) {
  const canvas = host.querySelectorAll<HTMLCanvasElement>('[data-testid=pdf-page-canvas]')[page];
  canvas.width = 600; canvas.height = 400;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  mock.canvases.set(page, canvas);
  mock.viewports.set(page, { width: 300, height: 200, convertToPdfPoint: (x: number, y: number) => [x, 200 - y] });
  return canvas;
}
const pointer = (target: Element, type: string, clientX: number, clientY: number) =>
  act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })); });
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

it('shows File not found when the store has no file for the path', async () => {
  await act(async () => root.render(<PdfView rel="missing.pdf" />));
  expect(host.textContent).toBe('File not found.');
});

it('explains a load failure with the sniffed type or the hook status, and offers no editing', async () => {
  mock.state = { loadFailed: true, bytes: new TextEncoder().encode('<!DOCTYPE html><html></html>'), status: 'ignored' };
  await render();
  expect(host.querySelector('.pdf-error-title')?.textContent).toBe("Couldn't open this PDF");
  expect(host.querySelector('.pdf-error-msg')?.textContent).toMatch(/^This file looks like .+ — not a PDF\./);
  expect(host.querySelector('.pdf-status')).toBeNull();
  expect(byTitle('Annotate, highlight, fill forms, reorder pages')).toBeNull();
  mock.state = { loadFailed: true, bytes: null, status: 'The file could not be read.' };
  await render();
  expect(host.querySelector('.pdf-error-msg')?.textContent).toBe('The file could not be read.');
});

it('shows the hook status line while the document is usable', async () => {
  mock.state = { status: 'Saved.' };
  await render();
  expect(host.querySelector('.pdf-status')?.textContent).toBe('Saved.');
});

it('keeps zoom within 50%–300% from the toolbar buttons', async () => {
  mock.state = { scale: 3, renderScale: 3 };
  await render();
  expect(host.querySelector('.pdf-zoom')?.textContent).toBe('300%');
  await act(async () => byTitle('Zoom in').click());
  expect(mock.setScale).not.toHaveBeenCalled();
  await act(async () => byTitle('Zoom out').click());
  expect(mock.setScale).toHaveBeenLastCalledWith(2.8);
  mock.setScale.mockReset();
  await act(async () => root.unmount());
  root = createRoot(host);
  mock.state = { scale: 0.5, renderScale: 0.5 };
  await render();
  await act(async () => byTitle('Zoom out').click());
  expect(mock.setScale).not.toHaveBeenCalled();
  await act(async () => byTitle('Zoom in').click());
  expect(mock.setScale).toHaveBeenLastCalledWith(0.7);
});

it('enables Save only for dirty edits and Save calls the hook save', async () => {
  await render();
  await enterEdit();
  const clean = [...host.querySelectorAll('button')].find(b => b.textContent === 'Saved')!;
  expect(clean.disabled).toBe(true);
  mock.state = { dirty: true };
  await render();
  const save = [...host.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(mock.save).toHaveBeenCalledOnce();
  expect(mock.state.dirty).toBe(true);
  expect(byTitle('Undo').disabled).toBe(false);
  await act(async () => byTitle('Undo').click());
  await act(async () => byTitle('Redo').click());
  expect(mock.undo).toHaveBeenCalledOnce();
  expect(mock.redo).toHaveBeenCalledOnce();
});

it('selects one tool, colour and text size at a time in edit mode', async () => {
  await render();
  await enterEdit();
  const pressed = () => [...host.querySelectorAll('.seg-btn[aria-pressed=true]')].map(b => b.getAttribute('aria-label'));
  expect(pressed()).toEqual(['Select and scroll']);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Highlight area"]')!.click());
  expect(pressed()).toEqual(['Highlight area']);
  expect(host.querySelector('.pdf-pages')?.classList.contains('tool-highlight')).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Set Red annotation color"]')!.click());
  expect([...host.querySelectorAll('.swatch.on')].map(b => b.getAttribute('title'))).toEqual(['Red']);
  const sizeSelect = host.querySelector<HTMLSelectElement>('.pdf-size')!;
  await act(async () => { sizeSelect.value = '24'; sizeSelect.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(sizeSelect.value).toBe('24');
  await act(async () => byTitle('Back to read-only viewing').click());
  expect(host.querySelector('.seg')).toBeNull();
  expect(host.querySelector('.pdf-pages')?.classList.contains('native-view')).toBe(true);
});

it('appends a blank page and sends page tools through the structural byte queue with edge buttons disabled', async () => {
  vi.useFakeTimers();
  mock.state = { pageCount: 3, firstPagePainted: true };
  await render();
  expect(allByTitle('Rotate left')).toHaveLength(0);
  await act(async () => { vi.advanceTimersByTime(20); });
  expect(host.querySelectorAll('.pdf-page-wrap')).toHaveLength(3);
  await enterEdit();
  await act(async () => byTitle('Append a blank US-Letter page').click());
  expect((await runApplied(0)).options).toEqual({ structural: true });
  expect(mock.edit.addBlankPage).toHaveBeenCalledWith(CURRENT);
  expect(allByTitle('Move up').map(b => b.disabled)).toEqual([true, false, false]);
  expect(allByTitle('Move down').map(b => b.disabled)).toEqual([false, false, true]);
  expect(allByTitle('Delete page').every(b => !b.disabled)).toBe(true);
  await act(async () => allByTitle('Rotate left')[1].click());
  await act(async () => allByTitle('Rotate right')[2].click());
  await act(async () => allByTitle('Move up')[1].click());
  await act(async () => allByTitle('Move down')[0].click());
  await act(async () => allByTitle('Delete page')[2].click());
  for (let i = 1; i <= 5; i += 1) expect((await runApplied(i)).options).toEqual({ structural: true });
  expect(mock.edit.rotatePage.mock.calls).toEqual([[CURRENT, 1, -90], [CURRENT, 2, 90]]);
  expect(mock.edit.movePage.mock.calls).toEqual([[CURRENT, 1, 0], [CURRENT, 0, 1]]);
  expect(mock.edit.deletePage).toHaveBeenCalledWith(CURRENT, 2);
});

it('refuses to delete the only page', async () => {
  await render();
  await enterEdit();
  expect(allByTitle('Delete page').map(b => b.disabled)).toEqual([true]);
});

it('places typed text at the clicked page point; Escape and empty text place nothing', async () => {
  await render();
  await enterEdit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add text"]')!.click());
  const canvas = pageCanvas();
  await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 40 })));
  let input = host.querySelector<HTMLInputElement>('.pdf-text-input')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('.pdf-text-input')).toBeNull();
  await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 40 })));
  input = host.querySelector<HTMLInputElement>('.pdf-text-input')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(host.querySelector('.pdf-text-input')).toBeNull();
  expect(mock.apply).not.toHaveBeenCalled();
  await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 40 })));
  input = host.querySelector<HTMLInputElement>('.pdf-text-input')!;
  await act(async () => typeInto(input, 'Hello'));
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(mock.apply).toHaveBeenCalledOnce();
  const { options } = await runApplied(0);
  expect(options).toEqual({ pages: [0] });
  expect(mock.edit.addText).toHaveBeenCalledWith(CURRENT, { page: 0, x: 50, y: 160, text: 'Hello', size: 14, color: { r: 0, g: 0, b: 0 } });
});

it('ignores page clicks before the page has a painted bitmap', async () => {
  await render();
  await enterEdit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add text"]')!.click());
  const canvas = pageCanvas();
  canvas.width = 0;
  await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 40 })));
  expect(host.querySelector('.pdf-text-input')).toBeNull();
});

it('draws a highlight box while dragging and adds a normalised highlight; a tiny drag adds nothing', async () => {
  await render();
  await enterEdit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Highlight area"]')!.click());
  const canvas = pageCanvas();
  await pointer(canvas, 'pointerdown', 100, 100);
  await pointer(canvas, 'pointermove', 40, 60);
  const box = host.querySelector<HTMLElement>('.pdf-dragbox')!;
  expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['40px', '60px', '60px', '40px']);
  await pointer(canvas, 'pointerup', 40, 60);
  expect(host.querySelector('.pdf-dragbox')).toBeNull();
  expect((await runApplied(0)).options).toEqual({ pages: [0] });
  expect(mock.edit.addHighlight).toHaveBeenCalledWith(CURRENT, { page: 0, x: 40, y: 100, width: 60, height: 40, color: { r: 0, g: 0, b: 0 } });
  await pointer(canvas, 'pointerdown', 10, 10);
  await pointer(canvas, 'pointerup', 11, 11);
  expect(mock.apply).toHaveBeenCalledOnce();
});

it('records every pencil point and applies one ink stroke on release', async () => {
  await render();
  await enterEdit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Draw with pencil"]')!.click());
  const canvas = pageCanvas();
  await pointer(canvas, 'pointerdown', 10, 10);
  await pointer(canvas, 'pointermove', 10.5, 10); // under 1.5 px: dropped
  await pointer(canvas, 'pointermove', 20, 10);
  await pointer(canvas, 'pointercancel', 30, 20);
  expect(mock.apply).toHaveBeenCalledOnce();
  await runApplied(0);
  expect(mock.edit.addInkStroke).toHaveBeenCalledWith(CURRENT, {
    page: 0, points: [{ x: 10, y: 190 }, { x: 20, y: 190 }, { x: 30, y: 180 }], thickness: 3.5, color: { r: 0, g: 0, b: 0 },
  });
  expect(host.querySelector('.pdf-ink-draft')).toBeNull();
});

it('replaces existing text with a clamped size; Escape and blank text replace nothing', async () => {
  mock.state = { textRuns: [{ page: 0, text: ' Old ', left: 5, top: 6, width: 40, height: 10, pdfX: 5, pdfY: 180, pdfWidth: 40, pdfHeight: 100 }] };
  await render();
  await enterEdit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit existing text"]')!.click());
  const hit = host.querySelector<HTMLButtonElement>('.pdf-text-hit')!;
  expect(hit.title).toBe('Edit "Old"');
  await act(async () => hit.click());
  let input = host.querySelector<HTMLInputElement>('.pdf-replace-input')!;
  expect(input.value).toBe(' Old ');
  expect(input.style.width).toBe('140px');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('.pdf-replace-input')).toBeNull();
  await act(async () => hit.click());
  input = host.querySelector<HTMLInputElement>('.pdf-replace-input')!;
  await act(async () => typeInto(input, '   '));
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(mock.apply).not.toHaveBeenCalled();
  await act(async () => hit.click());
  input = host.querySelector<HTMLInputElement>('.pdf-replace-input')!;
  await act(async () => typeInto(input, ' New '));
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await runApplied(0);
  expect(mock.edit.replaceText).toHaveBeenCalledWith(CURRENT, { page: 0, x: 5, y: 180, width: 40, height: 100, text: 'New', size: 64, color: { r: 0, g: 0, b: 0 } });
});

const FORM_FIELDS = [
  { name: 'agree', type: 'checkbox', value: 'false' },
  { name: 'tier', type: 'dropdown', value: 'a', options: ['a', 'b'] },
  { name: 'who', type: 'text', value: 'Ann' },
];
async function openForm() {
  mock.state = { fields: FORM_FIELDS };
  await render();
  await enterEdit();
  const formButton = [...host.querySelectorAll('button')].find(b => b.textContent === 'Form (3)')!;
  await act(async () => formButton.click());
  return formButton;
}

it('toggles the form panel and writes a changed text field once, through the byte queue', async () => {
  const formButton = await openForm();
  expect(host.querySelectorAll('.pdf-form-row')).toHaveLength(3);
  const text = host.querySelector<HTMLInputElement>('.pdf-form-panel input.text-input')!;
  await act(async () => { text.focus(); text.blur(); });
  expect(mock.apply).not.toHaveBeenCalled(); // unchanged text writes nothing
  await act(async () => { text.focus(); text.value = 'Bo'; text.blur(); });
  expect(mock.apply).toHaveBeenCalledOnce();
  await runApplied(0);
  expect(mock.edit.setFormField.mock.calls).toEqual([[CURRENT, 'who', 'Bo']]);
  await act(async () => formButton.click());
  expect(host.querySelector('.pdf-form-panel')).toBeNull();
});

// Bug: PdfView.tsx:908 and :921 read `e.target.checked` / `e.target.value`
// after `await loadPdfEditModule()`. Both inputs are controlled, so React has
// already restored the old value by then and the edit writes the unchanged value.
it('writes the new checkbox and choice values the user picked', async () => {
  await openForm();
  await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  const select = host.querySelector<HTMLSelectElement>('.pdf-form-panel select')!;
  await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(mock.apply).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 2; i += 1) await runApplied(i);
  expect(mock.edit.setFormField.mock.calls).toEqual([[CURRENT, 'agree', 'true'], [CURRENT, 'tier', 'b']]);
});

it('fits one page or a two-page spread to the width until the user zooms', async () => {
  const observers: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
  let width = 836;
  const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  try {
    mock.state = { pageCount: 2, pageSizes: new Map([[0, { width: 600, height: 800 }], [1, { width: 600, height: 800 }]]) };
    await render();
    expect(mock.setScale).toHaveBeenLastCalledWith(1.33);
    width = 1436;
    await act(async () => { for (const cb of observers) cb(); });
    expect(mock.setScale).toHaveBeenLastCalledWith(1.15);
    mock.setScale.mockReset();
    await act(async () => byTitle('Zoom in').click());
    expect(mock.setScale).toHaveBeenCalledTimes(1);
    width = 836;
    await act(async () => { for (const cb of observers) cb(); });
    expect(mock.setScale).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it('treats every mounted page as on screen without IntersectionObserver, and tracks intersections with one', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', undefined);
  mock.state = { pageCount: 2, firstPagePainted: true };
  await render();
  await act(async () => { vi.advanceTimersByTime(20); });
  expect(mock.setOnscreenPages).toHaveBeenLastCalledWith(new Set([0, 1]));
  await act(async () => root.unmount());
  root = createRoot(host);
  mock.setOnscreenPages.mockReset();
  let fire: ((entries: unknown[]) => void) | undefined;
  const observed: Element[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: (entries: unknown[]) => void) { fire = cb; }
    observe(el: Element) { observed.push(el); }
    disconnect() {}
  });
  await render();
  await act(async () => { vi.advanceTimersByTime(20); });
  expect(observed.length).toBeGreaterThan(0);
  const wraps = [...host.querySelectorAll('.pdf-page-wrap')];
  await act(async () => fire!([{ target: wraps[1], isIntersecting: true }, { target: document.createElement('div'), isIntersecting: true }]));
  expect(mock.setOnscreenPages).toHaveBeenLastCalledWith(new Set([1]));
  await act(async () => fire!([{ target: wraps[1], isIntersecting: false }, { target: wraps[0], isIntersecting: true }]));
  expect(mock.setOnscreenPages).toHaveBeenLastCalledWith(new Set([0]));
});

it('takes window-level undo and redo shortcuts only in edit mode while focus is not elsewhere', async () => {
  await render();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  expect(mock.undo).not.toHaveBeenCalled();
  await enterEdit();
  (document.activeElement as HTMLElement | null)?.blur();
  const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => window.dispatchEvent(undo));
  expect(mock.undo).toHaveBeenCalledOnce();
  expect(undo.defaultPrevented).toBe(true);
  const outside = document.createElement('button'); document.body.append(outside); outside.focus();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
  expect(mock.undo).toHaveBeenCalledOnce();
  outside.remove();
});
