import { describe, expect, it, vi } from 'vitest';
import { installCloseGuard, type CloseRequest } from './closeGuard';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
function setup(flush = vi.fn(async () => {})) {
  let callback!: (event: CloseRequest) => Promise<void>;
  let dirty = true;
  const stop = vi.fn(), error = vi.fn();
  const window = { onCloseRequested: vi.fn(async (cb: typeof callback) => { callback = cb; return stop; }), close: vi.fn(async () => {}) };
  const dispose = installCloseGuard(window, flush, () => dirty, error);
  return { window, flush, error, stop, dispose, request: () => { const event = { preventDefault: vi.fn() }; return { event, done: callback(event) }; }, clean: () => { dirty = false; } };
}
describe('native close guard behavior', () => {
  it('holds rapid close requests until saving finishes', async () => {
    const save = deferred(), s = setup(vi.fn(() => save.promise));
    const first = s.request(), second = s.request();
    expect(first.event.preventDefault).toHaveBeenCalledOnce(); expect(second.event.preventDefault).toHaveBeenCalledOnce(); expect(s.flush).toHaveBeenCalledOnce(); expect(s.window.close).not.toHaveBeenCalled();
    s.clean(); save.resolve(); await Promise.all([first.done, second.done]); expect(s.window.close).toHaveBeenCalledOnce();
    const final = s.request(); await final.done; expect(final.event.preventDefault).not.toHaveBeenCalled();
  });
  it('reflushes an edit arriving between the flush and final close request', async () => {
    const s = setup(); await s.request().done; await s.request().done; expect(s.flush).toHaveBeenCalledTimes(2);
  });
  it('keeps the window open after failure and retries on the next close', async () => {
    const s = setup(); s.flush.mockRejectedValueOnce(new Error('drive disconnected'));
    await s.request().done; expect(s.window.close).not.toHaveBeenCalled(); expect(s.error).toHaveBeenCalledWith(expect.stringContaining('drive disconnected'));
    await s.request().done; expect(s.window.close).toHaveBeenCalledOnce();
  });
  it('does not close a disposed window after delayed saving', async () => {
    const save = deferred(), s = setup(vi.fn(() => save.promise)); const request = s.request(); s.dispose(); save.resolve(); await request.done; expect(s.window.close).not.toHaveBeenCalled(); await Promise.resolve(); expect(s.stop).toHaveBeenCalledOnce();
  });
  it('reports listener registration failures', async () => {
    const error = vi.fn(); installCloseGuard({ onCloseRequested: async () => { throw new Error('permission'); }, close: async () => {} }, async () => {}, () => false, error);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Close safety failed to start')));
  });
});
