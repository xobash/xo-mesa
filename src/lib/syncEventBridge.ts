import { listen } from "@tauri-apps/api/event";
import {
  SYNC_LOG_EVENT,
  SYNC_PROGRESS_EVENT,
  mergeSyncLog,
  type SyncLogEntry,
  type SyncProgress,
} from "./syncProtocol";
import { IN_TAURI } from "./vault";

interface SyncBridgeState {
  syncLog: SyncLogEntry[];
}

interface SyncBridgeDeps {
  get: () => SyncBridgeState;
  set: (patch: { syncLog?: SyncLogEntry[]; syncProgress?: SyncProgress }) => void;
}

/** Own the native sync event subscription outside the central app store. */
export function createSyncEventBridge({ get, set }: SyncBridgeDeps) {
  let ready: Promise<void> | null = null;

  function append(entry: SyncLogEntry | SyncLogEntry[]): void {
    const next = mergeSyncLog(get().syncLog, entry);
    if (next !== get().syncLog) set({ syncLog: next });
  }

  return {
    ensure(): Promise<void> {
      if (!IN_TAURI) return Promise.resolve();
      if (!ready) {
        ready = (async () => {
          const unlistens: (() => void)[] = [];
          try {
            unlistens.push(await listen<SyncLogEntry | SyncLogEntry[]>(SYNC_LOG_EVENT, (event) => append(event.payload)));
            unlistens.push(await listen<SyncProgress>(SYNC_PROGRESS_EVENT, (event) => set({ syncProgress: event.payload })));
          } catch (error) {
            unlistens.forEach((unlisten) => { try { unlisten(); } catch { /* best effort */ } });
            throw error;
          }
        })().catch((error) => {
          ready = null;
          throw error;
        });
      }
      return ready;
    },
    log(level: SyncLogEntry["level"], msg: string): void {
      append({ ts: Date.now(), level, msg });
    },
  };
}
