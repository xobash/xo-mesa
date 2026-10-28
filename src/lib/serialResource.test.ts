import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { createLeasedResource } from './serialResource';

type Config = { name: string };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const events: string[] = [];
  const subscribe = vi.fn(async (handler: string) => { events.push(`sub ${handler}`); return () => { events.push(`unsub ${handler}`); }; });
  const start = vi.fn(async (config: Config) => { events.push(`start ${config.name}`); });
  const stop = vi.fn(async () => { events.push('stop'); });
  return { events, subscribe, start, stop, own: createLeasedResource<Config, string>({ subscribe, start, stop, same: (a, b) => a.name === b.name }) };
}
const settle = () => new Promise(r => setTimeout(r, 0));

describe('leased resource', () => {
  it('releases a lease before its subscription resolves without starting or leaking', async () => {
    const h = harness(); const sub = deferred<() => void>(); const unsub = vi.fn();
    h.subscribe.mockImplementationOnce(() => sub.promise);
    const release = h.own({ name: 'a' }, 'a');
    await settle(); release(); sub.resolve(unsub); await settle();
    expect(unsub).toHaveBeenCalledOnce(); expect(h.start).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
  });

  it('stops after a start that was still pending when the lease was released', async () => {
    const h = harness(); const started = deferred<void>();
    h.start.mockImplementationOnce(async (config: Config) => { h.events.push(`start ${config.name}`); await started.promise; });
    const release = h.own({ name: 'a' }, 'a');
    await settle(); release(); started.resolve(); await settle();
    expect(h.events).toEqual(['sub a', 'start a', 'unsub a', 'stop']);
  });

  it('keeps the resource running for the remaining holder and restores its config', async () => {
    const h = harness();
    const releaseA = h.own({ name: 'a' }, 'a'); await settle();
    const releaseB = h.own({ name: 'b' }, 'b'); await settle();
    releaseB(); await settle();
    expect(h.events).toEqual(['sub a', 'start a', 'sub b', 'stop', 'start b', 'unsub b', 'stop', 'start a']);
    releaseA(); await settle();
    expect(h.events.slice(-2)).toEqual(['unsub a', 'stop']);
  });

  it('does not restart when holders share a config and survives setup failure', async () => {
    const h = harness(); const error = vi.fn();
    const own = createLeasedResource<Config, string>({ subscribe: h.subscribe, start: h.start, stop: h.stop, same: () => true }, error);
    h.subscribe.mockRejectedValueOnce(new Error('listen failed'));
    own({ name: 'x' }, 'x'); const a = own({ name: 'a' }, 'a'); const b = own({ name: 'b' }, 'b'); await settle();
    expect(error).toHaveBeenCalledOnce(); expect(h.start).toHaveBeenCalledOnce();
    a(); await settle(); expect(h.stop).not.toHaveBeenCalled();
    b(); await settle(); expect(h.stop).toHaveBeenCalledOnce();
  });

  it('skips many disposed leases without retaining resources', async () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.own({ name: 'a' }, 'a')();
    await settle();
    expect(h.subscribe).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  });
});
