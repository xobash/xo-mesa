// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { SyncLogEntry, SyncProgress } from "./syncProtocol";

const io = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  failOn: null as string | null,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (io.failOn === name) throw new Error(`cannot listen to ${name}`);
    io.handlers.set(name, handler);
    return io.unlisten;
  }),
}));
vi.mock("./vault", () => ({ IN_TAURI: true }));
const { createSyncEventBridge } = await import("./syncEventBridge");
const { listen } = await import("@tauri-apps/api/event");

function harness() {
  let state: { syncLog: SyncLogEntry[]; syncProgress?: SyncProgress } = { syncLog: [] };
  const set = vi.fn((patch: Partial<typeof state>) => { state = { ...state, ...patch }; });
  return { bridge: createSyncEventBridge({ get: () => state, set }), state: () => state, set };
}
beforeEach(() => { io.handlers.clear(); io.unlisten.mockClear(); io.failOn = null; vi.mocked(listen).mockClear(); });

it("registers once and routes native log batches and progress into state", async () => {
  const h = harness();
  await Promise.all([h.bridge.ensure(), h.bridge.ensure()]);
  expect(listen).toHaveBeenCalledTimes(2);
  io.handlers.get("sync://log")!({ payload: [{ ts: 1, level: "info", msg: "a" }, { ts: 2, level: "warn", msg: "b" }] });
  io.handlers.get("sync://log")!({ payload: { ts: 3, level: "error", msg: "c" } });
  io.handlers.get("sync://progress")!({ payload: { phase: "transfer", done: 1, total: 2, rel: "a.md" } });
  expect(h.state().syncLog.map((entry) => entry.msg)).toEqual(["a", "b", "c"]);
  expect(h.state().syncProgress).toEqual({ phase: "transfer", done: 1, total: 2, rel: "a.md" });
  const sets = h.set.mock.calls.length;
  io.handlers.get("sync://log")!({ payload: [] });
  expect(h.set.mock.calls.length).toBe(sets);
  h.bridge.log("info", "local");
  expect(h.state().syncLog.at(-1)).toMatchObject({ level: "info", msg: "local" });
});

it("rolls back a partial registration and allows a clean retry", async () => {
  const h = harness();
  io.failOn = "sync://progress";
  await expect(h.bridge.ensure()).rejects.toThrow("cannot listen");
  expect(io.unlisten).toHaveBeenCalledOnce();
  io.failOn = null;
  await h.bridge.ensure();
  expect(listen).toHaveBeenCalledTimes(4);
});
