import { expect, it, vi } from "vitest";
import { DOCK_WINDOW_EVENT, GLOBAL_AGENT_EVENT } from "../lib/windowDock";
import { installDockBridge, type BridgeListen } from "./dockBridge";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeListen() {
  const pending = new Map<string, ReturnType<typeof deferred<() => void>>>();
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const listen: BridgeListen = (event, handler) => {
    handlers.set(event, handler);
    const next = deferred<() => void>();
    pending.set(event, next);
    return next.promise;
  };
  return { listen, pending, handlers };
}
const handlers = () => ({ dock: vi.fn(), globalAgent: vi.fn() });

it("routes dock and global-agent events once both listeners register", async () => {
  const fake = fakeListen(); const on = handlers(); const onError = vi.fn();
  const offDock = vi.fn(), offAgent = vi.fn();
  const dispose = installDockBridge(fake.listen, on, onError);
  fake.pending.get(DOCK_WINDOW_EVENT)!.resolve(offDock); await flush();
  fake.pending.get(GLOBAL_AGENT_EVENT)!.resolve(offAgent); await flush();
  fake.handlers.get(DOCK_WINDOW_EVENT)!({ payload: { kind: "agent" } });
  fake.handlers.get(GLOBAL_AGENT_EVENT)!({ payload: null });
  expect(on.dock).toHaveBeenCalledWith({ payload: { kind: "agent" } });
  expect(on.globalAgent).toHaveBeenCalledOnce();
  dispose();
  expect(offDock).toHaveBeenCalledOnce(); expect(offAgent).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
});

it("releases the dock listener when the global-agent listener fails, without an unhandled rejection", async () => {
  const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
  try {
    const fake = fakeListen(); const onError = vi.fn(); const offDock = vi.fn();
    const dispose = installDockBridge(fake.listen, handlers(), onError);
    fake.pending.get(DOCK_WINDOW_EVENT)!.resolve(offDock); await flush();
    fake.pending.get(GLOBAL_AGENT_EVENT)!.reject(new Error("ipc down")); await flush();
    expect(offDock).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "ipc down" }));
    dispose();
    expect(offDock).toHaveBeenCalledOnce();
    await flush();
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off("unhandledRejection", unhandled); }
});

it("releases both listeners when disposed before registration completes", async () => {
  const fake = fakeListen(); const offDock = vi.fn(), offAgent = vi.fn();
  const dispose = installDockBridge(fake.listen, handlers(), vi.fn());
  fake.pending.get(DOCK_WINDOW_EVENT)!.resolve(offDock); await flush();
  dispose();
  expect(offDock).toHaveBeenCalledOnce();
  fake.pending.get(GLOBAL_AGENT_EVENT)!.resolve(offAgent); await flush();
  expect(offAgent).toHaveBeenCalledOnce();

  const early = fakeListen(); const lateDock = vi.fn();
  installDockBridge(early.listen, handlers(), vi.fn())();
  early.pending.get(DOCK_WINDOW_EVENT)!.resolve(lateDock); await flush();
  expect(lateDock).toHaveBeenCalledOnce();
  expect(early.pending.has(GLOBAL_AGENT_EVENT)).toBe(false);
});
