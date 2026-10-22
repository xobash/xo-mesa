import { describe, expect, it, vi } from 'vitest';
import { installCloseGuard, pendingEditGuard, type CloseRequest } from './closeGuard';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
function setup(flush = vi.fn(async () => {}), onBlocked?: (reason: unknown) => Promise<"keep" | "discard">) {
  let callback!: (event: CloseRequest) => Promise<void>;
  let dirty = true;
  const stop = vi.fn(), error = vi.fn();
  const window = { onCloseRequested: vi.fn(async (cb: typeof callback) => { callback = cb; return stop; }), close: vi.fn(async () => {}) };
  const dispose = installCloseGuard(window, flush, () => dirty, error, onBlocked);
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
  it('holds a detached PDF window until its unsaved edit is saved', async () => {
    let pdfDirty = true;
    let onClose!: (event: CloseRequest) => Promise<void>;
    const close = vi.fn(async () => {});
    const error = vi.fn();
    installCloseGuard(
      { onCloseRequested: async (callback) => { onClose = callback; return () => {}; }, close },
      async () => { if (pdfDirty) throw new Error('Save the PDF before closing this window.'); },
      () => pdfDirty,
      error,
    );
    await vi.waitFor(() => expect(onClose).toBeDefined());
    const first = { preventDefault: vi.fn() };
    await onClose(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Save the PDF'));
    pdfDirty = false;
    const retry = { preventDefault: vi.fn() };
    await onClose(retry);
    expect(close).toHaveBeenCalledOnce();
    const permitted = { preventDefault: vi.fn() };
    await onClose(permitted);
    expect(permitted.preventDefault).not.toHaveBeenCalled();
  });
});

it('allows the next close after explicit discard following failure', async () => {
  const blocked = vi.fn(async () => "discard" as const);
  const s = setup(vi.fn(async () => { throw new Error('unsaveable'); }), blocked);
  await s.request().done;
  expect(blocked).toHaveBeenCalledOnce();
  expect(s.window.close).toHaveBeenCalledOnce();
  const final = s.request(); await final.done;
  expect(final.event.preventDefault).not.toHaveBeenCalled();
  s.dispose();
});
it('offers recovery after 15 seconds and cannot close from a late flush', async () => {
  vi.useFakeTimers();
  try {
    const save = deferred(), blocked = vi.fn(async () => "keep" as const);
    const s = setup(vi.fn(() => save.promise), blocked);
    const first = s.request();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(blocked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await first.done;
    expect(blocked).toHaveBeenCalledOnce();
    save.resolve(); await Promise.resolve();
    expect(s.window.close).not.toHaveBeenCalled();
    s.dispose();
  } finally { vi.useRealTimers(); }
});

describe('pending edit guard', () => {
  it('blocks close while a PDF editor is dirty even when text is saved', async () => {
    const state = { flushSave: vi.fn(async () => {}), textSaveState: { pending: 0 }, dirtyBinaryPaths: ['docs/Scan.pdf'] as string[] };
    const guard = pendingEditGuard(() => state);
    expect(guard.pending()).toBe(true);
    await expect(guard.flush()).rejects.toThrow('docs/Scan.pdf');
    expect(state.flushSave).toHaveBeenCalledOnce();
    const blocked = vi.fn(async () => 'keep' as const);
    const window = { onCloseRequested: vi.fn(async (cb: (event: CloseRequest) => Promise<void>) => { await cb({ preventDefault: vi.fn() }); return () => {}; }), close: vi.fn(async () => {}) };
    installCloseGuard(window, guard.flush, guard.pending, vi.fn(), blocked);
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
    expect(window.close).not.toHaveBeenCalled();
    state.dirtyBinaryPaths = [];
    expect(guard.pending()).toBe(false);
    await expect(guard.flush()).resolves.toBeUndefined();
  });
});
