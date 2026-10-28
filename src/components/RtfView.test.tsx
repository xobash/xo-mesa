// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ ensureContent: vi.fn() }));
vi.mock('../store', () => ({ useAppStore: (select: (s: Record<string, unknown>) => unknown) => select({ ensureContent: io.ensureContent }) }));
import { RtfView } from './RtfView';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it('renders RTF as plain text and ignores a reply for a previous file', async () => {
  let first!: (text: string) => void;
  io.ensureContent.mockImplementationOnce(() => new Promise((r) => { first = r; }));
  io.ensureContent.mockResolvedValueOnce('{\\rtf1\\ansi Second \\b file\\b0 .}');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<RtfView rel="a.rtf" />));
  await act(async () => root.render(<RtfView rel="b.rtf" />));
  await act(async () => { first('{\\rtf1 First file}'); await Promise.resolve(); });
  const text = host.querySelector('.rtf-text')!.textContent!;
  expect(text).toContain('Second');
  expect(text).toContain('file');
  expect(text).not.toContain('rtf1');
  expect(text).not.toContain('First');
  expect(io.ensureContent.mock.calls.map(([rel]) => rel)).toEqual(['a.rtf', 'b.rtf']);
});
