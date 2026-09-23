import { describe, expect, it, vi } from 'vitest';
import { createSerialResource } from './serialResource';
it('finishes old cleanup before starting a replacement, including delayed registration', async () => {
  const own = createSerialResource(), events: string[] = [];
  let resolve!: () => void; const wait = new Promise<void>(r => resolve = r);
  const release = own(async () => { events.push('old start'); await wait; return () => { events.push('old stop'); }; });
  await Promise.resolve(); release();
  const next = own(async () => { events.push('new start'); return () => { events.push('new stop'); }; });
  resolve(); await vi.waitFor(() => expect(events).toEqual(['old start', 'old stop', 'new start'])); next();
  await vi.waitFor(() => expect(events).toEqual(['old start', 'old stop', 'new start', 'new stop']));
});
describe('resource lifecycle churn', () => {
  it('skips disposed starts and survives failures without retaining resources', async () => {
    const own = createSerialResource(), start = vi.fn(async () => () => {}), error = vi.fn();
    for (let i = 0; i < 1000; i++) own(start)();
    own(async () => { throw new Error('setup failed'); }, error);
    const last = vi.fn(async () => () => {}); const release = own(last);
    await vi.waitFor(() => expect(last).toHaveBeenCalledOnce()); expect(start).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); release();
  });
});
