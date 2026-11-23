// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createStore } from "zustand";
const server = vi.hoisted(() => ({ started: [] as string[], stopped: 0 }));
vi.mock("../lib/sync", async (original) => ({
  ...(await original<object>()),
  startSyncServer: async (_port: number, _token: string, root: string) => { server.started.push(root); },
  stopSyncServer: async () => { server.stopped++; },
  retireSyncPeers: async () => {},
}));
import { useAppStore, type AppState } from "../store";
import { createSyncPeersController } from "./syncPeers";

it("keeps receiving on the newest vault when a switch lands while the previous start is still pending", async () => {
  const key = "credential:device";
  const settings = { ...useAppStore.getInitialState().settings, syncEnabled: true, syncToken: key };
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: "/a", syncListening: false, settings }));
  const sync = createSyncPeersController({ get: state.getState, set: state.setState, bootSettings: settings, getGeneration: () => 1,
    refreshMissingExternalFiles: async () => {}, reportingFailure: async (_l: string, run: () => Promise<void>) => run(), ensureSyncEventBridge: async () => {}, logSyncLocal: () => {} } as never);
  // Open A resumes listening; before its start reaches the queue, open B switches.
  const startA = sync.startListening("/a");
  state.setState({ vaultPath: "/b" });
  const resume = await sync.stopListening();
  if (resume) await sync.startListening("/b");
  await startA;
  expect(resume).toBe(true);
  expect(server.started).toEqual(["/b"]);
  expect(state.getState().syncListening).toBe(true);
});
