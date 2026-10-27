// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Native sync command facade: exact command names, arguments and failure handling. */
const native = vi.hoisted(() => ({
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
  replies: new Map<string, (args?: Record<string, unknown>) => unknown>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    native.calls.push({ cmd, args });
    const reply = native.replies.get(cmd);
    if (!reply) throw new Error(`unexpected command ${cmd}`);
    return reply(args);
  },
}));

type SyncModule = typeof import("./sync");

async function loadSync(inTauri: boolean): Promise<SyncModule> {
  vi.resetModules();
  const host = window as unknown as Record<string, unknown>;
  if (inTauri) host.__TAURI_INTERNALS__ = {};
  else delete host.__TAURI_INTERNALS__;
  return import("./sync");
}

const reply = (cmd: string, value: (args?: Record<string, unknown>) => unknown) => native.replies.set(cmd, value);
const fail = (cmd: string) => reply(cmd, () => { throw new Error(`${cmd} failed`); });

beforeEach(() => {
  native.calls = [];
  native.replies.clear();
  reply("sync_secrets_import", (args) => `credential:session-${String(args?.value).length}`);
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("native sync commands", () => {
  it("runs a sync with an imported session credential and a normalized HTTPS base", async () => {
    const sync = await loadSync(true);
    const report = { pulled: ["a.md"], pushed: [], failed: [] };
    reply("sync_run", () => report);
    await expect(sync.syncWithPeer("/vault", "peer.example:8787/", "a".repeat(64))).resolves.toBe(report);
    expect(native.calls).toEqual([
      { cmd: "sync_secrets_import", args: { value: "a".repeat(64) } },
      { cmd: "sync_run", args: { root: "/vault", base: "https://peer.example:8787", token: "credential:session-64", pin: null, retry: null, peerName: null } },
    ]);
  });

  it("passes a stored credential, pin, retry list and peer label through unchanged", async () => {
    const sync = await loadSync(true);
    reply("sync_run", () => ({}));
    await sync.syncWithPeer("/vault", "https://peer.example", "credential:stored", "ab".repeat(32), ["note.md"], "Laptop");
    expect(native.calls).toEqual([
      { cmd: "sync_run", args: { root: "/vault", base: "https://peer.example", token: "credential:stored", pin: "ab".repeat(32), retry: ["note.md"], peerName: "Laptop" } },
    ]);
    native.calls = [];
    await sync.syncWithPeer("/vault", "https://peer.example", "credential:stored", null, []);
    expect(native.calls[0].args).toMatchObject({ pin: null, retry: null });
  });

  it("summarizes a remote manifest and reports its certificate fingerprint", async () => {
    const sync = await loadSync(true);
    reply("sync_fetch_manifest", () => ({
      fingerprint: "f".repeat(64),
      files: [{ rel: "a.md", size: 10, hash: "1".repeat(64) }, { rel: "b.png", size: 2048, hash: "2".repeat(64) }],
    }));
    await expect(sync.fetchRemoteVaultInfo("203.0.113.5:8787", "credential:stored", "c".repeat(64)))
      .resolves.toEqual({ files: 2, bytes: 2058, fingerprint: "f".repeat(64) });
    expect(native.calls).toEqual([
      { cmd: "sync_fetch_manifest", args: { base: "https://203.0.113.5:8787", token: "credential:stored", pin: "c".repeat(64) } },
    ]);
  });

  it("propagates a failed sync or manifest probe to the caller", async () => {
    const sync = await loadSync(true);
    fail("sync_run");
    fail("sync_fetch_manifest");
    await expect(sync.syncWithPeer("/vault", "peer", "credential:stored")).rejects.toThrow("sync_run failed");
    await expect(sync.fetchRemoteVaultInfo("peer", "credential:stored")).rejects.toThrow("sync_fetch_manifest failed");
  });

  it("starts and stops the receiver with the selected address", async () => {
    const sync = await loadSync(true);
    reply("sync_start", () => undefined);
    reply("sync_stop", () => undefined);
    await sync.startSyncServer(8787, "credential:stored", "/vault");
    await sync.startSyncServer(9000, "credential:stored", "/vault", "192.0.2.10");
    await sync.stopSyncServer();
    expect(native.calls).toEqual([
      { cmd: "sync_start", args: { port: 8787, token: "credential:stored", vault: "/vault", bindAddress: "127.0.0.1" } },
      { cmd: "sync_start", args: { port: 9000, token: "credential:stored", vault: "/vault", bindAddress: "192.0.2.10" } },
      { cmd: "sync_stop", args: undefined },
    ]);
  });

  it("reports status, address and identity, and treats native failures as unknown", async () => {
    const sync = await loadSync(true);
    reply("sync_status", () => true);
    reply("sync_local_addr", () => "192.0.2.4");
    reply("sync_identity", () => "e".repeat(64));
    await expect(sync.syncServerRunning()).resolves.toBe(true);
    await expect(sync.localSyncAddr()).resolves.toBe("192.0.2.4");
    await expect(sync.syncIdentity()).resolves.toBe("e".repeat(64));
    for (const cmd of ["sync_status", "sync_local_addr", "sync_identity"]) fail(cmd);
    await expect(sync.syncServerRunning()).resolves.toBe(false);
    await expect(sync.localSyncAddr()).resolves.toBeNull();
    await expect(sync.syncIdentity()).resolves.toBeNull();
  });

  it("starts and stops discovery, cancels quietly and retires peers in one batch", async () => {
    const sync = await loadSync(true);
    for (const cmd of ["sync_discovery_start", "sync_discovery_stop", "sync_retire_peer"]) reply(cmd, () => undefined);
    fail("sync_cancel");
    await sync.startSyncDiscovery("Sunny Otter", 8787, true);
    await sync.stopSyncDiscovery();
    await expect(sync.cancelSync()).resolves.toBeUndefined();
    await sync.retireSyncPeers("/vault", ["a".repeat(64), "b".repeat(64)]);
    await sync.retireSyncPeer("/vault", "c".repeat(64));
    await sync.retireSyncPeers("/vault", []);
    expect(native.calls).toEqual([
      { cmd: "sync_discovery_start", args: { name: "Sunny Otter", port: 8787, listening: true } },
      { cmd: "sync_discovery_stop", args: undefined },
      { cmd: "sync_cancel", args: undefined },
      { cmd: "sync_retire_peer", args: { root: "/vault", fingerprints: ["a".repeat(64), "b".repeat(64)] } },
      { cmd: "sync_retire_peer", args: { root: "/vault", fingerprints: ["c".repeat(64)] } },
    ]);
  });
});

describe("browser preview without the native shell", () => {
  it("never calls native sync commands for status, discovery, cancel or retirement", async () => {
    const sync = await loadSync(false);
    await expect(sync.syncServerRunning()).resolves.toBe(false);
    await expect(sync.localSyncAddr()).resolves.toBeNull();
    await expect(sync.syncIdentity()).resolves.toBeNull();
    await sync.startSyncDiscovery("Sunny Otter", 8787, false);
    await sync.stopSyncDiscovery();
    await sync.cancelSync();
    await sync.retireSyncPeers("/vault", ["a".repeat(64)]);
    expect(native.calls).toEqual([]);
  });
});
