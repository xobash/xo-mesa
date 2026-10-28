import { listen } from "@tauri-apps/api/event";
import { startSyncDiscovery, stopSyncDiscovery, type DiscoveryPacket } from "./syncUi";

export interface LeasedResourceDeps<C, H> {
  subscribe(handler: H): Promise<() => void>;
  start(config: C): Promise<void>;
  stop(): Promise<void>;
  same(a: C, b: C): boolean;
}

/**
 * One process-wide resource shared by several holders. Each lease keeps its
 * own subscription; the resource runs with the newest live lease's config and
 * stops only when no lease remains. Setup and teardown run in one queue, so a
 * stop always precedes the next start and a released lease leaves nothing
 * behind, even when it is released before its setup completes.
 */
export function createLeasedResource<C, H>(deps: LeasedResourceDeps<C, H>, onError: (error: unknown) => void = () => {}) {
  interface Lease { config: C; disposed: boolean; unsubscribe?: () => void }
  const live: Lease[] = [];
  let running: C | null = null;
  let tail = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => { tail = tail.then(step).catch(onError); };
  const reconcile = async () => {
    const want = live.length ? live[live.length - 1].config : null;
    if (running !== null && (want === null || !deps.same(running, want))) {
      running = null;
      await deps.stop();
    }
    if (want !== null && running === null) {
      await deps.start(want);
      running = want;
    }
  };
  return (config: C, handler: H): (() => void) => {
    const lease: Lease = { config, disposed: false };
    enqueue(async () => {
      if (lease.disposed) return;
      const unsubscribe = await deps.subscribe(handler);
      if (lease.disposed) { unsubscribe(); return; }
      lease.unsubscribe = unsubscribe;
      live.push(lease);
      await reconcile();
    });
    return () => {
      if (lease.disposed) return;
      lease.disposed = true;
      enqueue(async () => {
        const index = live.indexOf(lease);
        if (index < 0) return;
        live.splice(index, 1);
        lease.unsubscribe?.();
        lease.unsubscribe = undefined;
        await reconcile();
      });
    };
  };
}

export interface SyncDiscoveryConfig { name: string; port: number; listening: boolean }

/** The single owner of native LAN discovery for every sync surface. */
export const syncDiscovery = createLeasedResource<SyncDiscoveryConfig, (packet: DiscoveryPacket) => void>({
  subscribe: (handler) => listen<DiscoveryPacket>("sync://discovered", (event) => handler(event.payload)),
  start: (config) => startSyncDiscovery(config.name, config.port, config.listening),
  stop: () => stopSyncDiscovery(),
  same: (a, b) => a.name === b.name && a.port === b.port && a.listening === b.listening,
});
