import { parsePeerInput } from "../lib/pairing";
import { persistSettings, scrubStoredSyncSecrets } from "../lib/settings";
import { createSyncWorkflow } from "../lib/syncWorkflow";
import { validSyncKey } from "../lib/syncKey";
import { hydrateSyncSecrets, persistSyncSecrets, resetNativeSyncSecrets, syncSecretSignature } from "../lib/syncSecrets";
import type { SyncLogEntry } from "../lib/sync";
import { IN_TAURI, authorizeVaultRoot, pickVault } from "../lib/vault";
import type { Settings, SyncPeer } from "../types";

import type { VaultPort } from "./vaultExternalFiles";
import type { AppState } from "../storeTypes";

interface Dependencies extends VaultPort {
  /** Settings read at boot; native sync secrets hydrate over these values. */
  bootSettings: Settings;
  getGeneration: () => number;
  refreshMissingExternalFiles: (root: string, isCurrent: () => boolean) => Promise<void>;
  reportingFailure: (label: string, run: () => Promise<void>) => Promise<void>;
  ensureSyncEventBridge: () => Promise<void>;
  logSyncLocal: (level: SyncLogEntry["level"], message: string) => void;
}

const secretStoreError = (error: unknown) =>
  `Sync credentials could not be saved in the OS credential store: ${String(error)}. Keep this window open and retry.`;

/** Owns settings commits, native sync secrets, the receive listener and peers.
 *  Secret writes are serialized; the listener queue serializes start/stop. */
export function createSyncPeersController({
  get, set, bootSettings, getGeneration, refreshMissingExternalFiles,
  reportingFailure, ensureSyncEventBridge, logSyncLocal,
}: Dependencies) {
  let secretsLoad: Promise<void> | null = null;
  let secretsWriteTail: Promise<void> = Promise.resolve();
  let secretSaveError = "";
  if (!IN_TAURI) {
    try { scrubStoredSyncSecrets(); } catch { /* Keep unreadable settings for recovery. */ }
  }

  function loadSyncSecrets(): Promise<void> {
    if (!IN_TAURI) return Promise.resolve();
    if (!secretsLoad) {
      secretsLoad = hydrateSyncSecrets(bootSettings).then(hydrated => {
        const current = get().settings;
        const boot = bootSettings;
        const bootPeers = new Map(boot.peers.map(peer => [peer.id, peer.token]));
        const hydratedPeers = new Map(hydrated.peers.map(peer => [peer.id, peer.token]));
        set({ settings: {
          ...current,
          syncToken: current.syncToken === boot.syncToken ? hydrated.syncToken : current.syncToken,
          peers: current.peers.map(peer => ({
            ...peer,
            token: peer.token === bootPeers.get(peer.id)
              ? hydratedPeers.get(peer.id)
              : peer.token,
          })),
        } });
      }).catch(error => {
        secretsLoad = null;
        secretSaveError = String(error);
        set({ settingsIssue: `Sync credentials could not be loaded from the OS credential store: ${String(error)}. Existing saved keys were preserved.` });
        throw error;
      });
    }
    return secretsLoad;
  }

  /** Queue a native write of the current secrets; tokens edited meanwhile win. */
  function queueSecretWrite(clearIssue: boolean): void {
    secretsWriteTail = secretsWriteTail.then(async () => {
      await loadSyncSecrets();
      const submitted = get().settings;
      const secured = await persistSyncSecrets(submitted);
      const current = get().settings;
      set({ settings: { ...current,
        syncToken: current.syncToken === submitted.syncToken ? secured.syncToken : current.syncToken,
        peers: current.peers.map(peer => ({ ...peer, token: peer.token === submitted.peers.find(p => p.id === peer.id)?.token ? secured.peers.find(p => p.id === peer.id)?.token : peer.token })),
      } });
      secretSaveError = "";
      if (clearIssue) set({ settingsIssue: "" });
    }).catch(error => {
      secretSaveError = String(error);
      set({ settingsIssue: secretStoreError(error) });
    });
  }

  function commitSettings(settings: Settings): void {
    const secretChanged = syncSecretSignature(settings) !== syncSecretSignature(get().settings);
    const settingsIssue = persistSettings(settings);
    set({ settings, settingsIssue: secretSaveError ? secretStoreError(secretSaveError) : settingsIssue });
    if (IN_TAURI && secretChanged) queueSecretWrite(false);
  }

  let listenerTail: Promise<void> = Promise.resolve();
  function queueListener<T>(work: () => Promise<T>): Promise<T> {
    const next = listenerTail.then(work, work);
    listenerTail = next.then(() => {}, () => {});
    return next;
  }
  async function stopListening(): Promise<boolean> {
    return queueListener(async () => {
      if (!get().syncListening) return false;
      const { stopSyncServer } = await import("../lib/sync");
      await stopSyncServer();
      set({ syncListening: false });
      return true;
    });
  }
  async function startListening(root: string): Promise<void> {
    await loadSyncSecrets();
    await secretsWriteTail;
    if (secretSaveError) throw new Error(`Sync key was not saved: ${secretSaveError}`);
    await queueListener(async () => {
      const s = get();
      if (s.vaultPath !== root || !s.settings.syncEnabled || !validSyncKey(s.settings.syncToken)) return;
      const { startSyncServer, retireSyncPeers } = await import("../lib/sync");
      await retireSyncPeers(root, s.settings.retiredSyncPeers ?? []);
      if (get().vaultPath !== root || !get().settings.syncEnabled) return;
      const current = get().settings;
      await startSyncServer(current.syncPort, current.syncToken, root, current.syncBindAddress);
      set({ syncListening: true, syncStatus: `Listening on port ${current.syncPort}.` });
    });
  }

  /** Apply the sync side effects of a committed setting change. */
  function settingChanged(key: keyof Settings, value: unknown): void {
    if (key === "syncEnabled" && value === false) {
      void stopListening().catch((error) => set({ syncStatus: `Could not stop server: ${String(error)}` }));
      void get().cancelCurrentSync();
      set({ syncStatus: "Sync disabled." });
    }
    if ((key === "syncToken" || key === "syncPort" || key === "syncBindAddress") && get().syncListening) {
      void queueListener(async () => {
        await secretsWriteTail;
        const current = get();
        if (!current.syncListening || !current.vaultPath || !current.settings.syncEnabled) return;
        if (secretSaveError) {
          const { stopSyncServer } = await import("../lib/sync");
          await stopSyncServer();
          set({ syncListening: false, syncStatus: `Receive stopped: sync key was not saved in the OS credential store.` });
          return;
        }
        if (!validSyncKey(current.settings.syncToken)) {
          const { stopSyncServer } = await import("../lib/sync");
          await stopSyncServer();
          set({ syncListening: false, syncStatus: "Receive stopped: generate a 64-character lowercase hex key." });
          return;
        }
        const { startSyncServer } = await import("../lib/sync");
        await startSyncServer(current.settings.syncPort, current.settings.syncToken, current.vaultPath, current.settings.syncBindAddress);
        set({ syncStatus: `Listening on port ${current.settings.syncPort}.` });
      }).catch((error) => set({ syncListening: false, syncStatus: `Could not restart server: ${String(error)}` }));
    }
  }

  const actions: Pick<AppState,
    "loadSyncSecrets" | "resetSyncKeys" | "retrySettings" | "addPeer" | "updatePeer" | "removePeer" |
    "receiveSharedVault" | "toggleListen" | "syncNow" | "syncAll" | "cancelCurrentSync"> = {
    loadSyncSecrets,
    resetSyncKeys: async () => {
      const key = await resetNativeSyncSecrets();
      // The damaged record is gone; forget its failed load and error.
      secretsLoad = null;
      secretSaveError = "";
      const current = get().settings;
      commitSettings({ ...current, syncToken: key, peers: current.peers.map(peer => ({ ...peer, token: undefined })) });
    },
    retrySettings: () => {
      commitSettings(get().settings);
      if (IN_TAURI) queueSecretWrite(true);
    },

    addPeer: (input, name, fingerprint) => {
      const address = parsePeerInput(input);
      if (!address) return null;
      const peers = get().settings.peers;
      const fp = fingerprint
        ? fingerprint.replace(/[^0-9a-fA-F]/g, "").toLowerCase()
        : undefined;
      const existing = peers.find((p) => p.address === address);
      if (existing) {
        // Learn the fingerprint from discovery if we didn't have one yet.
        if (fp && !existing.fingerprint) {
          get().updatePeer(existing.id, { fingerprint: fp });
        }
        return existing.id;
      }
      const id = `peer-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const peer: SyncPeer = {
        id,
        name: (name && name.trim()) || address,
        address,
        favorite: false,
        fingerprint: fp,
      };
      commitSettings({
        ...get().settings, peers: [...peers, peer],
        retiredSyncPeers: get().settings.retiredSyncPeers?.filter(value => value !== fp)
      });
      return id;
    },
    updatePeer: (id, patch) => {
      get().setSetting(
        "peers",
        get().settings.peers.map((p) => (p.id === id ? { ...p, ...patch } : p))
      );
    },
    removePeer: async (id) => {
      const peer = get().settings.peers.find(peer => peer.id === id);
      if (!peer) return;
      await reportingFailure("Remove sync peer", async () => {
        if (get().syncBusy) throw new Error("Stop sync before removing a peer.");
        const root = get().vaultPath;
        if (root && peer.fingerprint) {
          const { retireSyncPeer } = await import("../lib/sync");
          await retireSyncPeer(root, peer.fingerprint);
        }
        commitSettings({
          ...get().settings, peers: get().settings.peers.filter(peer => peer.id !== id),
          retiredSyncPeers: [...new Set([...(get().settings.retiredSyncPeers ?? []), ...(peer.fingerprint ? [peer.fingerprint] : [])])]
        });
      });
    },

    receiveSharedVault: async ({ address, token, name, fingerprint }) => {
      // The caller has already confirmed the address + key reach a Mesa vault
      // and observed its certificate fingerprint. Let the user choose where it
      // lands, then clone into it.
      const root = await pickVault();
      if (!root) return null; // folder picker cancelled

      set({ loading: true, status: "Downloading shared vault…" });
      try {
        await loadSyncSecrets();
        await authorizeVaultRoot(root);
        // Two-way sync against the freshly chosen folder: an empty folder pulls
        // everything; a non-empty one merges safely (conflicts become copies).
        await ensureSyncEventBridge();
        const { syncWithPeer } = await import("../lib/sync");
        const result = await syncWithPeer(root, address, token, fingerprint ?? null, null, name);

        // Remember the key + device so ongoing sync just works.
        if (!get().settings.syncToken.trim()) {
          get().setSetting("syncToken", token);
          await secretsWriteTail;
          if (secretSaveError) throw new Error(`Sync key was not saved: ${secretSaveError}`);
        }
        if (!get().settings.syncEnabled) {
          get().setSetting("syncEnabled", true);
        }
        get().addPeer(address, name, fingerprint ?? result.fingerprint);

        await get().openVault(root); // scan + display the cloned vault
        set({
          syncStatus: `Cloned shared vault — ↓${result.pulled} file${result.pulled === 1 ? "" : "s"
            }`,
        });
        return result;
      } catch (e) {
        set({ loading: false, status: "" });
        throw e instanceof Error ? e : new Error(String(e));
      }
    },

    toggleListen: async () => {
      try { await loadSyncSecrets(); } catch { return; }
      const s = get();
      if (!s.vaultPath) return;
      if (!s.settings.syncEnabled) {
        set({ syncStatus: "Sync is disabled." });
        return;
      }
      if (s.syncListening) {
        try {
          await stopListening();
          set({ syncStatus: "Stopped listening." });
        } catch (error) {
          set({ syncStatus: `Could not stop server: ${String(error)}` });
        }
        return;
      }
      if (!validSyncKey(s.settings.syncToken)) {
        set({ syncStatus: "Generate a 64-character lowercase hex sync key before receiving." });
        return;
      }
      try {
        await startListening(s.vaultPath);
      } catch (e) {
        set({ syncStatus: `Could not start server: ${String(e)}` });
      }
    },

    ...createSyncWorkflow({
      get, set,
      generation: getGeneration,
      prepare: async () => {
        await loadSyncSecrets();
        await secretsWriteTail;
        if (secretSaveError) throw new Error(`Sync key was not saved: ${secretSaveError}`);
        await ensureSyncEventBridge();
      },
      transfer: (root, address, token, fingerprint, retry, admitted, peerName) =>
        import("../lib/sync").then(async ({ syncWithPeer, retireSyncPeers }) => {
          if (!admitted()) throw new Error("Sync cancelled before peer retirement.");
          await retireSyncPeers(root, get().settings.retiredSyncPeers ?? []);
          if (!admitted()) throw new Error("Sync cancelled before transfer.");
          return syncWithPeer(root, address, token, fingerprint, retry, peerName);
        }),
      cancel: () => import("../lib/sync").then(({ cancelSync }) => cancelSync()),
      refresh: refreshMissingExternalFiles,
      log: logSyncLocal,
    }),
  };

  return { actions, commitSettings, settingChanged, stopListening, startListening };
}
