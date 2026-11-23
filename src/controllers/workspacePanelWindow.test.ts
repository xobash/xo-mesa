// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createStore } from "zustand";
const fixture = vi.hoisted(() => ({ created: [] as string[], saved: [] as (() => void)[] }));
vi.mock("../lib/vault", async (original) => ({ ...(await original<object>()), IN_TAURI: true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = vi.fn(async () => null);
    label: string;
    constructor(label: string) { fixture.created.push(label); this.label = label; }
    once() { return Promise.resolve(() => {}); }
  },
}));
// The snapshot save is slow for a heavy vault: hold it until the test releases it.
vi.mock("../lib/graphWindowBootstrap", () => ({
  saveGraphWindowBootstrap: () => new Promise<boolean>((resolve) => fixture.saved.push(() => resolve(true))),
  discardGraphWindowBootstrap: async () => {},
}));
import { useAppStore, type AppState } from "../store";
import { createWorkspaceController } from "./workspace";

it("creates one graph window for two tear-outs in quick succession, and docks nothing", async () => {
  const setSetting = vi.fn();
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: "/vault", setSetting }));
  const { actions } = createWorkspaceController({ get: state.getState, set: state.setState, commitSettings: vi.fn() });
  const first = actions.openPanelWindow("graph");
  const second = actions.openPanelWindow("graph");
  await vi.waitFor(() => expect(fixture.saved.length).toBeGreaterThan(0));
  for (const release of fixture.saved) release();
  await Promise.all([first, second]);
  expect(fixture.created).toEqual(["panel-graph"]);
  expect(setSetting).not.toHaveBeenCalled();
});
