// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand";
import type { Settings, SyncPeer } from "../types";

const m = vi.hoisted(() => ({
  flags: { tauri: true },
  hydrate: vi.fn(async (settings: Settings): Promise<Settings> => settings),
  persist: vi.fn(async (settings: Settings): Promise<Settings> => settings),
  reset: vi.fn(async () => "credential:device"),
  start: vi.fn(async (_port: number, _token: string, _root: string, _bind?: string) => {}),
  stop: vi.fn(async () => {}),
  retireMany: vi.fn(async (_root: string, _fps: string[]) => {}),
  retireOne: vi.fn(async (_root: string, _fp: string) => {}),
  syncWithPeer: vi.fn(async (..._args: unknown[]) => ({ pulled: 1, pushed: 0, conflicts: 0, failed: [], cancelled: false, fingerprint: "ab" })),
  cancelSync: vi.fn(async () => {}),
  pickVault: vi.fn(async (): Promise<string | null> => "/picked"),
  authorize: vi.fn(async (_root: string) => {}),
}));

vi.mock("../lib/vault", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    get IN_TAURI() { return m.flags.tauri; },
    pickVault: m.pickVault,
    authorizeVaultRoot: m.authorize,
  };
});
vi.mock("../lib/syncSecrets", async (original) => ({
  ...await original<object>(),
  hydrateSyncSecrets: m.hydrate,
  persistSyncSecrets: m.persist,
  resetNativeSyncSecrets: m.reset,
}));
vi.mock("../lib/sync", async (original) => ({
  ...await original<object>(),
  startSyncServer: m.start,
  stopSyncServer: m.stop,
  retireSyncPeers: m.retireMany,
  retireSyncPeer: m.retireOne,
  syncWithPeer: m.syncWithPeer,
  cancelSync: m.cancelSync,
}));

import { useAppStore, type AppState } from "../store";
import { createSyncPeersController } from "./syncPeers";

const KEY = "credential:device";
const peer = (patch: Partial<SyncPeer> = {}): SyncPeer =>
  ({ id: "p1", name: "Laptop", address: "192.0.2.2:8787", favorite: false, ...patch }) as SyncPeer;

type Controller = ReturnType<typeof createSyncPeersController>;
let state: StoreApi<AppState>;
let sync: Controller;
let cancelCurrentSync: ReturnType<typeof vi.fn>;
let openVault: ReturnType<typeof vi.fn>;

function setup(settings: Partial<Settings> = {}, extra: Partial<AppState> = {}, boot?: Settings) {
  const base = { ...useAppStore.getInitialState().settings, syncEnabled: true, syncToken: KEY, syncPort: 8787, peers: [], ...settings } as Settings;
  cancelCurrentSync = vi.fn(async () => {});
  openVault = vi.fn(async () => {});
  state = createStore<AppState>(() => ({
    ...useAppStore.getInitialState(),
    vaultPath: "/vault",
    syncListening: false,
    syncBusy: false,
    settingsIssue: "",
    settings: base,
    flushSave: async () => {},
    openVault: openVault as unknown as AppState["openVault"],
    ...extra,
  }));
  sync = createSyncPeersController({
    get: state.getState,
    set: state.setState,
    bootSettings: boot ?? base,
    getGeneration: () => 1,
    refreshMissingExternalFiles: async () => {},
    reportingFailure: async (label: string, run: () => Promise<void>) => {
      try { await run(); } catch (error) { state.setState({ status: `${label} failed: ${String(error)}` }); }
    },
    ensureSyncEventBridge: async () => {},
    logSyncLocal: () => {},
  } as never);
  // Mirror the store's setSetting: commit, then apply sync side effects.
  state.setState({
    ...sync.actions,
    cancelCurrentSync: cancelCurrentSync as unknown as AppState["cancelCurrentSync"],
    setSetting: ((key: keyof Settings, value: unknown) => {
      sync.commitSettings({ ...state.getState().settings, [key]: value } as Settings);
      sync.settingChanged(key, value);
    }) as AppState["setSetting"],
  });
}

const settle = () => vi.waitFor(async () => { await Promise.resolve(); });
const s = () => state.getState();

beforeEach(() => {
  m.flags.tauri = true;
  vi.clearAllMocks();
  m.hydrate.mockImplementation(async (settings) => settings);
  m.persist.mockImplementation(async (settings) => settings);
  m.start.mockImplementation(async () => {});
  m.stop.mockImplementation(async () => {});
  m.pickVault.mockImplementation(async () => "/picked");
  localStorage.clear();
});

describe("receiving reconfiguration", () => {
  it("a port, key or bind change while receiving restarts the server with the new values", async () => {
    setup({ syncBindAddress: "127.0.0.1" }, { syncListening: true });
    s().setSetting("syncPort", 9000);
    await vi.waitFor(() => expect(m.start).toHaveBeenCalledWith(9000, KEY, "/vault", "127.0.0.1"));
    expect(s().syncStatus).toBe("Listening on port 9000.");
    s().setSetting("syncBindAddress", "0.0.0.0");
    await vi.waitFor(() => expect(m.start).toHaveBeenLastCalledWith(9000, KEY, "/vault", "0.0.0.0"));
    s().setSetting("syncToken", "credential:session:" + "a".repeat(64));
    await vi.waitFor(() => expect(m.start).toHaveBeenLastCalledWith(9000, "credential:session:" + "a".repeat(64), "/vault", "0.0.0.0"));
    expect(m.stop).not.toHaveBeenCalled();
  });

  it("an invalid key while receiving stops the server instead of serving it", async () => {
    setup({}, { syncListening: true });
    s().setSetting("syncToken", "weak");
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledTimes(1));
    expect(m.start).not.toHaveBeenCalled();
    expect(s().syncListening).toBe(false);
    expect(s().syncStatus).toBe("Receive stopped: generate a 64-character lowercase hex key.");
  });

  it("a key the credential store refused stops receiving and keeps the issue visible", async () => {
    setup({}, { syncListening: true });
    m.persist.mockRejectedValueOnce(new Error("keychain locked"));
    s().setSetting("syncToken", "credential:peer:x");
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledTimes(1));
    expect(s().syncListening).toBe(false);
    expect(s().syncStatus).toBe("Receive stopped: sync key was not saved in the OS credential store.");
    expect(s().settingsIssue).toMatch(/could not be saved in the OS credential store: Error: keychain locked/);
    // A later unrelated commit keeps reporting the failed secret save.
    sync.commitSettings({ ...s().settings, sortMode: s().settings.sortMode });
    expect(s().settingsIssue).toMatch(/keychain locked/);
    // Starting again refuses until the key is saved.
    await expect(sync.startListening("/vault")).rejects.toThrow(/Sync key was not saved/);
  });

  it("a failed restart reports and marks receiving off", async () => {
    setup({}, { syncListening: true });
    m.start.mockRejectedValueOnce(new Error("port in use"));
    s().setSetting("syncPort", 9001);
    await vi.waitFor(() => expect(s().syncStatus).toBe("Could not restart server: Error: port in use"));
    expect(s().syncListening).toBe(false);
  });

  it("a key change while not receiving starts nothing", async () => {
    setup();
    s().setSetting("syncPort", 9002);
    await settle();
    expect(m.start).not.toHaveBeenCalled();
    expect(m.stop).not.toHaveBeenCalled();
  });

  it("turning sync off stops receiving and cancels the current sync", async () => {
    setup({}, { syncListening: true });
    s().setSetting("syncEnabled", false);
    expect(s().syncStatus).toBe("Sync disabled.");
    expect(cancelCurrentSync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledTimes(1));
    expect(s().syncListening).toBe(false);
  });

  it("a failed stop on disable is reported", async () => {
    setup({}, { syncListening: true });
    m.stop.mockRejectedValueOnce(new Error("busy"));
    s().setSetting("syncEnabled", false);
    await vi.waitFor(() => expect(s().syncStatus).toBe("Could not stop server: Error: busy"));
  });
});

describe("toggleListen", () => {
  it("retires peers natively before it listens, then stops on the next toggle", async () => {
    setup({ retiredSyncPeers: ["dead"], syncBindAddress: "127.0.0.1" });
    await s().toggleListen();
    expect(m.retireMany).toHaveBeenCalledWith("/vault", ["dead"]);
    expect(m.retireMany.mock.invocationCallOrder[0]).toBeLessThan(m.start.mock.invocationCallOrder[0]);
    expect(m.start).toHaveBeenCalledWith(8787, KEY, "/vault", "127.0.0.1");
    expect(s().syncListening).toBe(true);
    expect(s().syncStatus).toBe("Listening on port 8787.");
    await s().toggleListen();
    expect(m.stop).toHaveBeenCalledTimes(1);
    expect(s().syncListening).toBe(false);
    expect(s().syncStatus).toBe("Stopped listening.");
  });

  it("refuses without a vault, with sync off, or with an invalid key", async () => {
    setup({}, { vaultPath: null });
    await s().toggleListen();
    expect(m.start).not.toHaveBeenCalled();
    setup({ syncEnabled: false });
    await s().toggleListen();
    expect(s().syncStatus).toBe("Sync is disabled.");
    setup({ syncToken: "abc" });
    await s().toggleListen();
    expect(s().syncStatus).toBe("Generate a 64-character lowercase hex sync key before receiving.");
    expect(m.start).not.toHaveBeenCalled();
  });

  it("reports start and stop failures", async () => {
    setup();
    m.start.mockRejectedValueOnce(new Error("bind failed"));
    await s().toggleListen();
    expect(s().syncStatus).toBe("Could not start server: Error: bind failed");
    expect(s().syncListening).toBe(false);
    state.setState({ syncListening: true });
    m.stop.mockRejectedValueOnce(new Error("stuck"));
    await s().toggleListen();
    expect(s().syncStatus).toBe("Could not stop server: Error: stuck");
  });

  it("a vault switch during retirement abandons the start", async () => {
    setup();
    m.retireMany.mockImplementationOnce(async () => { state.setState({ vaultPath: "/other" }); });
    await s().toggleListen();
    expect(m.start).not.toHaveBeenCalled();
    expect(s().syncListening).toBe(false);
  });

  it("does nothing when the credential store cannot load", async () => {
    setup();
    m.hydrate.mockRejectedValueOnce(new Error("denied"));
    await s().toggleListen();
    expect(m.start).not.toHaveBeenCalled();
    expect(s().settingsIssue).toMatch(/could not be loaded .*denied.*Existing saved keys were preserved/);
  });
});

describe("credential store", () => {
  it("hydrates boot tokens once but keeps tokens edited since boot", async () => {
    const boot = { ...useAppStore.getInitialState().settings, syncEnabled: true, syncToken: "", peers: [peer({ id: "p1" }), peer({ id: "p2", address: "192.0.2.3:8787" })] } as Settings;
    setup({}, {}, boot);
    state.setState({ settings: { ...boot, peers: [peer({ id: "p1" }), peer({ id: "p2", address: "192.0.2.3:8787", token: "typed" })] } });
    m.hydrate.mockResolvedValueOnce({ ...boot, syncToken: "credential:device", peers: [peer({ id: "p1", token: "credential:peer:p1" }), peer({ id: "p2", token: "credential:peer:p2" })] });
    await s().loadSyncSecrets();
    await s().loadSyncSecrets();
    expect(m.hydrate).toHaveBeenCalledTimes(1);
    expect(s().settings.syncToken).toBe("credential:device");
    expect(s().settings.peers.map((p) => p.token)).toEqual(["credential:peer:p1", "typed"]);
  });

  it("a failed load can be retried", async () => {
    setup();
    m.hydrate.mockRejectedValueOnce(new Error("locked"));
    await expect(s().loadSyncSecrets()).rejects.toThrow("locked");
    await s().loadSyncSecrets();
    expect(m.hydrate).toHaveBeenCalledTimes(2);
  });

  it("a committed secret is replaced by its native reference, unless edited meanwhile", async () => {
    setup({ syncToken: "" });
    let release!: () => void;
    m.persist.mockImplementationOnce((submitted) => new Promise((resolve) => {
      release = () => resolve({ ...submitted, syncToken: "credential:device", peers: submitted.peers });
    }));
    sync.commitSettings({ ...s().settings, syncToken: "a".repeat(64) });
    await vi.waitFor(() => expect(m.persist).toHaveBeenCalledTimes(1));
    expect(m.persist.mock.calls[0][0].syncToken).toBe("a".repeat(64));
    release();
    await vi.waitFor(() => expect(s().settings.syncToken).toBe("credential:device"));

    m.persist.mockImplementationOnce((submitted) => new Promise((resolve) => {
      release = () => resolve({ ...submitted, syncToken: "credential:device" });
    }));
    sync.commitSettings({ ...s().settings, syncToken: "b".repeat(64) });
    await vi.waitFor(() => expect(m.persist).toHaveBeenCalledTimes(2));
    state.setState({ settings: { ...s().settings, syncToken: "typed-later" } });
    release();
    await settle();
    await vi.waitFor(() => expect(m.persist).toHaveBeenCalledTimes(2));
    expect(s().settings.syncToken).toBe("typed-later");
  });

  it("a commit without a secret change never touches the credential store", async () => {
    setup();
    sync.commitSettings({ ...s().settings, syncPort: 9100 });
    await settle();
    expect(m.persist).not.toHaveBeenCalled();
    expect(s().settings.syncPort).toBe(9100);
  });

  it("retrySettings rewrites secrets and clears the issue once they save", async () => {
    setup();
    m.persist.mockRejectedValueOnce(new Error("locked"));
    sync.commitSettings({ ...s().settings, syncToken: "credential:peer:z" });
    await vi.waitFor(() => expect(s().settingsIssue).toMatch(/locked/));
    s().retrySettings();
    await vi.waitFor(() => expect(s().settingsIssue).toBe(""));
    expect(m.persist).toHaveBeenCalledTimes(2);
  });

  it("the browser build never loads or writes native secrets", async () => {
    m.flags.tauri = false;
    setup();
    await s().loadSyncSecrets();
    sync.commitSettings({ ...s().settings, syncToken: "credential:peer:y" });
    s().retrySettings();
    await settle();
    expect(m.hydrate).not.toHaveBeenCalled();
    expect(m.persist).not.toHaveBeenCalled();
  });

  it("resetSyncKeys commits the new device key, drops peer tokens and forgets the old failure", async () => {
    setup({ peers: [peer({ token: "credential:peer:p1" })] });
    m.hydrate.mockRejectedValueOnce(new Error("damaged"));
    await expect(s().loadSyncSecrets()).rejects.toThrow("damaged");
    m.reset.mockResolvedValueOnce("credential:device");
    await s().resetSyncKeys();
    expect(s().settings.syncToken).toBe("credential:device");
    expect(s().settings.peers[0].token).toBeUndefined();
    await s().loadSyncSecrets();
    expect(m.hydrate).toHaveBeenCalledTimes(2);
  });
});

describe("peers", () => {
  it("addPeer rejects bad input and names a new peer by its address", () => {
    setup();
    expect(s().addPeer("   ")).toBeNull();
    const id = s().addPeer("192.0.2.9:8787")!;
    expect(id).toMatch(/^peer-/);
    expect(s().settings.peers).toEqual([expect.objectContaining({ id, name: "192.0.2.9:8787", address: "192.0.2.9:8787", favorite: false })]);
  });

  it("re-adding a retired fingerprint clears its retirement", () => {
    setup({ retiredSyncPeers: ["abcd", "ffff"] });
    s().addPeer("192.0.2.9:8787", "  Desk  ", "AB:CD");
    expect(s().settings.peers[0]).toEqual(expect.objectContaining({ name: "Desk", fingerprint: "abcd" }));
    expect(s().settings.retiredSyncPeers).toEqual(["ffff"]);
  });

  it("an address already known returns its id and learns a missing fingerprint once", () => {
    setup({ peers: [peer()] });
    expect(s().addPeer("192.0.2.2:8787", "Other", "EE")).toBe("p1");
    expect(s().settings.peers).toHaveLength(1);
    expect(s().settings.peers[0].fingerprint).toBe("ee");
    s().addPeer("192.0.2.2:8787", "Other", "FF");
    expect(s().settings.peers[0].fingerprint).toBe("ee");
  });

  it("removePeer retires the fingerprint natively and persists the retirement", async () => {
    setup({ peers: [peer({ fingerprint: "ab" }), peer({ id: "p2", address: "192.0.2.3:8787" })], retiredSyncPeers: ["ab"] });
    await s().removePeer("p1");
    expect(m.retireOne).toHaveBeenCalledWith("/vault", "ab");
    expect(s().settings.peers.map((p) => p.id)).toEqual(["p2"]);
    expect(s().settings.retiredSyncPeers).toEqual(["ab"]);
    // A peer without a fingerprint has nothing to retire.
    await s().removePeer("p2");
    expect(m.retireOne).toHaveBeenCalledTimes(1);
    expect(s().settings.peers).toEqual([]);
    await s().removePeer("missing");
    expect(m.retireOne).toHaveBeenCalledTimes(1);
  });

  it("removePeer refuses while a sync runs and keeps the peer", async () => {
    setup({ peers: [peer({ fingerprint: "ab" })] }, { syncBusy: true });
    await s().removePeer("p1");
    expect(s().status).toBe("Remove sync peer failed: Error: Stop sync before removing a peer.");
    expect(s().settings.peers).toHaveLength(1);
    expect(m.retireOne).not.toHaveBeenCalled();
  });
});

describe("receiveSharedVault", () => {
  const share = { address: "192.0.2.5:8787", token: "credential:session:" + "c".repeat(64), name: "Studio", fingerprint: "AA" };

  it("a cancelled folder picker does nothing", async () => {
    setup();
    m.pickVault.mockResolvedValueOnce(null);
    await expect(s().receiveSharedVault(share)).resolves.toBeNull();
    expect(m.syncWithPeer).not.toHaveBeenCalled();
  });

  it("clones into the chosen folder, remembers key, sync and device, then opens it", async () => {
    setup({ syncEnabled: false, syncToken: "" });
    const result = await s().receiveSharedVault(share);
    expect(result).toEqual(expect.objectContaining({ pulled: 1 }));
    expect(m.authorize).toHaveBeenCalledWith("/picked");
    expect(m.syncWithPeer).toHaveBeenCalledWith("/picked", share.address, share.token, "AA", null, "Studio");
    expect(s().settings.syncToken).toBe(share.token);
    expect(s().settings.syncEnabled).toBe(true);
    expect(s().settings.peers).toEqual([expect.objectContaining({ address: share.address, name: "Studio", fingerprint: "aa" })]);
    expect(openVault).toHaveBeenCalledWith("/picked");
    expect(s().syncStatus).toBe("Cloned shared vault — ↓1 file");
  });

  it("keeps an existing device key", async () => {
    setup();
    await s().receiveSharedVault({ ...share, fingerprint: undefined });
    expect(s().settings.syncToken).toBe(KEY);
    // Without a supplied fingerprint, the observed one from the transfer is kept.
    expect(s().settings.peers[0].fingerprint).toBe("ab");
  });

  it("a failed clone clears loading and rethrows an Error", async () => {
    setup();
    m.syncWithPeer.mockRejectedValueOnce("unreachable");
    await expect(s().receiveSharedVault(share)).rejects.toThrow("unreachable");
    expect(s().loading).toBe(false);
    expect(s().status).toBe("");
    expect(openVault).not.toHaveBeenCalled();
  });

  it("a key the credential store refused stops the clone before it is remembered", async () => {
    setup({ syncToken: "" });
    m.persist.mockRejectedValueOnce(new Error("locked"));
    await expect(s().receiveSharedVault(share)).rejects.toThrow(/Sync key was not saved/);
    expect(openVault).not.toHaveBeenCalled();
  });
});

describe("sync workflow wiring", () => {
  it("syncNow retires peers before the transfer", async () => {
    setup({ peers: [peer({ fingerprint: "ab" })], retiredSyncPeers: ["dead"] });
    await s().syncNow("p1");
    expect(m.retireMany).toHaveBeenCalledWith("/vault", ["dead"]);
    expect(m.syncWithPeer).toHaveBeenCalledWith("/vault", "192.0.2.2:8787", KEY, "ab", null, "Laptop");
    expect(m.retireMany.mock.invocationCallOrder[0]).toBeLessThan(m.syncWithPeer.mock.invocationCallOrder[0]);
  });

  it("syncNow stops when the key could not be saved", async () => {
    setup({ peers: [peer()] });
    m.persist.mockRejectedValueOnce(new Error("locked"));
    sync.commitSettings({ ...s().settings, syncToken: "credential:peer:q" });
    await s().syncNow("p1");
    expect(m.syncWithPeer).not.toHaveBeenCalled();
    expect(s().syncStatus).toMatch(/^Sync stopped: Error: Sync key was not saved/);
  });

  it("cancelling a running transfer asks native sync to cancel", async () => {
    setup({ peers: [peer()] });
    let finish!: () => void;
    m.syncWithPeer.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ pulled: 0, pushed: 0, conflicts: 0, failed: [], cancelled: true, fingerprint: "" });
    }));
    state.setState({ cancelCurrentSync: sync.actions.cancelCurrentSync });
    const run = s().syncNow("p1");
    await vi.waitFor(() => expect(m.syncWithPeer).toHaveBeenCalled());
    await s().cancelCurrentSync();
    expect(m.cancelSync).toHaveBeenCalledTimes(1);
    finish();
    await run;
    expect(s().syncBusy).toBe(false);
  });
});
