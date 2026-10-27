import { expect, it, vi } from 'vitest';
import { readBoundedText } from './boundedText';
function handle(text: string, chunk = 2) { const bytes = new TextEncoder().encode(text); let offset = 0; return { close: vi.fn(async () => {}), read: vi.fn(async (buffer: Uint8Array) => { const count = Math.min(chunk, buffer.length, bytes.length - offset); buffer.set(bytes.subarray(offset, offset + count)); offset += count; return count; }) }; }
it('joins partial reads and requires EOF, including split UTF-8', async () => { const h = handle('héllo'); expect(await readBoundedText(h, 6)).toBe('héllo'); expect(h.close).toHaveBeenCalledOnce(); });
it('refuses a growing file instead of returning an editable prefix', async () => { const h = handle('too long'); await expect(readBoundedText(h, 4)).rejects.toThrow('limit'); expect(h.close).toHaveBeenCalledOnce(); expect(h.read.mock.calls.every(([buf]) => buf.length <= 5)).toBe(true); });
it('closes on read failure', async () => { const h = handle(''); h.read.mockRejectedValueOnce(new Error('disconnected')); await expect(readBoundedText(h, 5)).rejects.toThrow('disconnected'); expect(h.close).toHaveBeenCalledOnce(); });

it('rejects invalid UTF-8 instead of saving replacement characters', async () => {
  const h = handle('');
  h.read.mockImplementationOnce(async buffer => { buffer[0] = 0xff; return 1; });
  await expect(readBoundedText(h, 5)).rejects.toThrow();
  expect(h.close).toHaveBeenCalledOnce();
});
