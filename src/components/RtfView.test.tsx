// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(async (_job: { bytes: Uint8Array; expected: Uint8Array | null }) => undefined),
  confirm: vi.fn(async () => true),
  adoptSaved: vi.fn(),
  file: { path: '/v/Letter.rtf', name: 'Letter.rtf', mtime: 1 } as { path: string; name: string; mtime: number },
}));
vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select({ fileFor: () => io.file, adoptSavedBytes: io.adoptSaved }) }));
vi.mock('../lib/confirmAction', () => ({ confirmAction: io.confirm }));
vi.mock('../lib/documentBytesSave', () => ({
  readDocumentBytes: io.read,
  saveDocumentBytes: io.save,
  DocumentChangedOnDiskError: class extends Error {},
}));
import { rtfToText } from '../lib/rtf';
import { RtfView } from './RtfView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SOURCE = '{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}{\\colortbl;\\red200\\green0\\blue0;}\\f0\\fs24 Hello \\b world\\b0 \\cf1 red\\par Second}';
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => String.fromCharCode(...b);
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const onDirty = vi.fn();

beforeEach(() => {
  io.file = { path: '/v/Letter.rtf', name: 'Letter.rtf', mtime: 1 };
  io.read.mockResolvedValue(bytes(SOURCE));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

async function mount(editable = true) {
  await act(async () => root.render(<RtfView rel="Letter.rtf" editable={editable} onDirtyChange={onDirty} />));
  await vi.waitFor(() => expect(host.querySelector('.rtf-page')!.textContent).toContain('Second'));
}
const page = () => host.querySelector<HTMLElement>('.rtf-page')!;
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)!;
async function type(node: Text, value: string) {
  await act(async () => { node.nodeValue = value; page().dispatchEvent(new Event('input', { bubbles: true })); });
}

it('shows paragraphs, bold and colour from the file bytes', async () => {
  await mount();
  const paragraphs = page().querySelectorAll('p');
  expect(paragraphs).toHaveLength(2);
  const bold = Array.from(page().querySelectorAll('span')).find((s) => s.textContent === 'world')!;
  expect(bold.style.fontWeight).toBe('700');
  const red = Array.from(page().querySelectorAll('span')).find((s) => s.textContent === 'red')!;
  expect(red.style.color).toBe('rgb(200, 0, 0)');
  expect(page().getAttribute('contenteditable')).toBe('true');
});

it('saves only the edited text against the opened bytes and writes nothing when unchanged', async () => {
  await mount();
  await act(async () => button('Save').click());
  expect(io.save).not.toHaveBeenCalled();
  const hello = page().querySelector('span')!.firstChild as Text;
  await type(hello, 'Howdy ');
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await act(async () => button('Save').click());
  expect(io.save).toHaveBeenCalledOnce();
  const job = io.save.mock.calls[0][0];
  expect(text(job.expected!)).toBe(SOURCE);
  const written = text(job.bytes);
  expect(written.startsWith('{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}{\\colortbl;\\red200\\green0\\blue0;}\\f0\\fs24 ')).toBe(true);
  expect(written.endsWith('\\b world\\b0 \\cf1 red\\par Second}')).toBe(true);
  expect(rtfToText(written)).toBe('Howdy worldred\nSecond');
  await vi.waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  // The store learns the saved text, so the file watcher does not report
  // Mesa's own save as a change made outside Mesa.
  expect(io.adoptSaved).toHaveBeenCalledWith('Letter.rtf', job.bytes, '/v/Letter.rtf');
});

it('keeps edits and says so when the file changes on disk while dirty', async () => {
  await mount();
  await type(page().querySelector('span')!.firstChild as Text, 'Edited ');
  io.read.mockResolvedValue(bytes(SOURCE.replace('Second', 'Changed elsewhere')));
  io.file = { ...io.file, mtime: 2 };
  await act(async () => root.render(<RtfView rel="Letter.rtf" editable onDirtyChange={onDirty} />));
  await vi.waitFor(() => expect(host.textContent).toContain('changed on disk'));
  expect(page().textContent).toContain('Edited');
  expect(page().textContent).not.toContain('Changed elsewhere');
});

it('opens unsupported constructs read-only with the reason', async () => {
  io.read.mockResolvedValue(bytes('{\\rtf1 a\\cell b\\par Second}'));
  await mount();
  expect(page().getAttribute('contenteditable')).toBe('false');
  expect(host.textContent).toContain('it contains a table');
  expect(button('Save').disabled).toBe(true);
});

it('is view-only without the editor guard (previews)', async () => {
  await mount(false);
  expect(page().getAttribute('contenteditable')).toBe('false');
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
});

it('applies bold to the selection through the format model', async () => {
  await mount();
  const hello = page().querySelector('span')!.firstChild as Text;
  const range = document.createRange();
  range.setStart(hello, 0); range.setEnd(hello, 5);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  await act(async () => host.querySelector<HTMLButtonElement>('.rtf-toggle-b')!.click());
  const bolded = Array.from(page().querySelectorAll('span')).find((s) => s.textContent === 'Hello')!;
  expect(bolded.style.fontWeight).toBe('700');
  await act(async () => button('Save').click());
  expect(text(io.save.mock.calls[0][0].bytes)).toContain('{\\b Hello}');
});

it('stops typing while a save writes, so re-rendering the saved bytes cannot drop it', async () => {
  await mount();
  let release!: () => void;
  io.save.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
  await type(page().querySelector('span')!.firstChild as Text, 'Howdy ');
  await act(async () => button('Save').click());
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledOnce());
  expect(page().getAttribute('contenteditable')).toBe('false');
  await act(async () => { release(); });
  await vi.waitFor(() => expect(page().getAttribute('contenteditable')).toBe('true'));
});

it('shares unchanged paragraphs between undo snapshots and reads a very long paragraph', async () => {
  const { paragraphsOf, shareParagraphs, sameParagraphs, unitsOf } = await import('./rtfDom');
  const { parseRtfDocument } = await import('../lib/rtfDocument');
  const doc = parseRtfDocument(String.raw`{\rtf1\ansi{\fonttbl{\f0 Helvetica;}}\f0\fs24 One\par Two\par Three\par Four}`);
  const previous = paragraphsOf(doc);
  expect(previous).toHaveLength(4);
  const copy = () => paragraphsOf(doc); // an equal snapshot made of new objects, as a read of the page is
  const char = (ch: string) => ({ kind: 'char' as const, ch, fmt: previous[1].fmt });

  // An edit: only the edited paragraph is a new object.
  const edited = copy();
  edited[1] = { ...edited[1], items: [...edited[1].items, char('!')] };
  const shared = shareParagraphs(previous, edited);
  expect(shared.map((p, k) => p === previous[k])).toEqual([true, false, true, true]);
  expect(sameParagraphs(shared, edited)).toBe(true);

  // A split and a join: paragraphs after the change are matched from the end.
  const split = copy();
  split.splice(1, 1, { ...split[1], items: split[1].items.slice(0, 1) }, { ...split[1], items: split[1].items.slice(1) });
  const afterSplit = shareParagraphs(previous, split);
  expect(afterSplit).toHaveLength(5);
  expect([afterSplit[0] === previous[0], afterSplit[3] === previous[2], afterSplit[4] === previous[3]]).toEqual([true, true, true]);
  const joined = copy();
  joined.splice(1, 2, { ...joined[1], items: [...joined[1].items, ...joined[2].items] });
  expect(shareParagraphs(previous, joined).map((p) => previous.indexOf(p))).toEqual([0, -1, 3]);

  // A paragraph with a different typing format is not shared, even with equal text.
  const restyled = copy();
  restyled[2] = { ...restyled[2], fmt: { ...restyled[2].fmt, b: !restyled[2].fmt.b } };
  expect(shareParagraphs(previous, restyled)[2]).toBe(restyled[2]);

  // 200,000 characters in one paragraph: more than one call can take as arguments.
  const long = [{ ...previous[0], items: Array.from({ length: 200_000 }, () => char('x')) }, previous[1]];
  expect(unitsOf(long)).toHaveLength(200_000 + 1 + previous[1].items.length);
});
