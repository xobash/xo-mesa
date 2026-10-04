// @vitest-environment jsdom
/**
 * The NATIVE vault watcher wiring (`vault_watch` / `vault_unwatch`,
 * src-tauri/src/vaultwatch.rs) and its `watchVault` frontend branch.
 *
 * Why this exists: `tauri-plugin-fs`'s `watch` emits one IPC message per raw
 * filesystem event, and on Windows every one is a WebView2 UI-thread `eval`
 * plus a forced repaint. A `git checkout`, a device sync, or a Pi agent writing
 * hundreds of files inside the vault therefore stalls typing/scrolling for the
 * duration of the write. `vault_watch` filters `.git`/dot churn and coalesces a
 * whole debounce window into ONE message; the Rust reduction is pinned in
 * `vaultwatch.rs` tests (a 3,301-event checkout window → 1 send; a 5,000-event
 * `.git` storm → 0). This file pins the frontend contract:
 *
 *  - a native batch reaches `onChange` unchanged, and a MALFORMED message is
 *    dropped rather than fed into `handleExternalChange` (a silent-corruption
 *    class of bug), and
 *  - when the native command is unavailable, `watchVault` falls back to the
 *    plugin `watch` so external-change detection still works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const ROOT = "/vault";

type Rec = Record<string, unknown>;
let invokeCalls: { cmd: string; args: Rec }[] = [];
let watchCalls = 0;
/** Per-test: set to make `invoke("vault_watch", …)` reject (fallback path). */
let vaultWatchRejects = false;
/** The last Channel handed to `invoke("vault_watch")`, so a test can push a
 *  native message through it. */
let lastChannel: { onmessage: (msg: unknown) => void } | undefined;

class FakeChannel {
  onmessage: (msg: unknown) => void = () => {};
}

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  Channel: FakeChannel,
  invoke: async (cmd: string, args: Rec) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "vault_watch") {
      if (vaultWatchRejects) throw new Error("no such command");
      lastChannel = args.onEvent as { onmessage: (msg: unknown) => void };
      return 42;
    }
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async () => [],
  readTextFile: async () => "",
  readFile: async () => new Uint8Array(),
  writeFile: async () => {},
  remove: async () => {},
  rename: async () => {},
  mkdir: async () => {},
  exists: async () => false,
  stat: async () => ({ size: 0, mtime: new Date(0) }),
  watch: async () => {
    watchCalls++;
    return () => {};
  },
  open: async () => ({ read: async () => 0, close: async () => {} }),
}));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { watchVault, decodeWatchBatch } = await import("./vault");

beforeEach(() => {
  invokeCalls = [];
  watchCalls = 0;
  vaultWatchRejects = false;
  lastChannel = undefined;
});

describe("decodeWatchBatch", () => {
  it("passes a well-formed batch through unchanged", () => {
    const batch = [
      { paths: ["/vault/a.md"], kind: "create" },
      { paths: ["/vault/b.md", "/vault/c.md"], kind: "modify" },
    ];
    expect(decodeWatchBatch(batch)).toEqual(batch);
  });

  it("rejects a non-array message", () => {
    expect(decodeWatchBatch(null)).toBeNull();
    expect(decodeWatchBatch("nope")).toBeNull();
    expect(decodeWatchBatch({ paths: ["/vault/a.md"] })).toBeNull();
  });

  it("rejects a batch whose item is missing paths", () => {
    expect(decodeWatchBatch([{ kind: "modify" }])).toBeNull();
    expect(decodeWatchBatch([{ paths: "x", kind: "modify" }])).toBeNull();
  });

  it("drops non-string paths and items left with no paths", () => {
    expect(
      decodeWatchBatch([
        { paths: [1, "/vault/a.md", null], kind: "modify" },
        { paths: [true, 2], kind: "modify" },
      ])
    ).toEqual([{ paths: ["/vault/a.md"], kind: "modify" }]);
  });

  it("defaults an unknown kind to modify", () => {
    expect(
      decodeWatchBatch([{ paths: ["/vault/a.md"], kind: "weird" }])
    ).toEqual([{ paths: ["/vault/a.md"], kind: "modify" }]);
  });

  it("returns null when nothing survives", () => {
    expect(decodeWatchBatch([])).toBeNull();
    expect(decodeWatchBatch([{ paths: [], kind: "modify" }])).toBeNull();
  });
});

describe("watchVault native path", () => {
  it("no-ops in the browser demo", async () => {
    const stop = await watchVault("mesa://demo/sub", () => {});
    expect(invokeCalls).toHaveLength(0);
    expect(watchCalls).toBe(0);
    stop();
  });

  it("starts the native watcher and routes a batch to onChange", async () => {
    const seen: unknown[] = [];
    const stop = await watchVault(ROOT, (events) => seen.push(events));

    const started = invokeCalls.find((c) => c.cmd === "vault_watch");
    expect(started?.args.root).toBe(ROOT);
    expect(watchCalls).toBe(0); // native path — plugin watch NOT used

    lastChannel?.onmessage([{ paths: ["/vault/n.md"], kind: "create" }]);
    expect(seen).toEqual([[{ paths: ["/vault/n.md"], kind: "create" }]]);

    stop();
    expect(invokeCalls.some((c) => c.cmd === "vault_unwatch")).toBe(true);
  });

  it("never forwards a malformed native message to onChange", async () => {
    const seen: unknown[] = [];
    await watchVault(ROOT, (events) => seen.push(events));
    lastChannel?.onmessage("garbage");
    lastChannel?.onmessage({ not: "an array" });
    lastChannel?.onmessage([{ kind: "create" }]); // no paths
    expect(seen).toHaveLength(0);
  });

  it("stops delivering after unwatch", async () => {
    const seen: unknown[] = [];
    const stop = await watchVault(ROOT, (events) => seen.push(events));
    stop();
    lastChannel?.onmessage([{ paths: ["/vault/late.md"], kind: "modify" }]);
    expect(seen).toHaveLength(0);
  });

  it("falls back to the plugin watch when the native command is unavailable", async () => {
    vaultWatchRejects = true;
    const stop = await watchVault(ROOT, () => {});
    expect(invokeCalls.some((c) => c.cmd === "vault_watch")).toBe(true);
    expect(watchCalls).toBe(1); // fell through to tauri-plugin-fs `watch`
    stop();
  });
});
