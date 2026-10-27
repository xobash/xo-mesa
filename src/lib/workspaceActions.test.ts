import { describe, expect, it, vi } from "vitest";
import { createWorkspaceActions } from "./workspaceActions";
import type { Settings } from "../types";

const settings = { centerView: "doc", rightStack: ["tasks"], dockSide: "right" } as Settings;

describe("workspace action domain", () => {
  it.each([{ rightStack: ["graph"] }, { rightStack: ["preview", "tasks"] }, { rightStack: ["graph", "agent"] }] as { rightStack: Settings["rightStack"] }[])("docks Pi across the whole side pane, replacing %j", ({ rightStack }) => {
    let state = { settings: { ...settings, centerView: "doc" as const, rightStack, rightWidth: 444 } as Settings, dragView: null, graphFull: true };
    const actions = createWorkspaceActions({ get: () => state, set: (patch) => { if (patch.graphFull !== undefined) state.graphFull = patch.graphFull; }, commitSettings: (next) => { state = { ...state, settings: next }; }, setSetting: vi.fn() });
    actions.moveViewToRight("agent");
    expect(state.settings).toMatchObject({ centerView: "doc", rightStack: ["agent"], rightWidth: 444 });
    expect(state.graphFull).toBe(false);
  });

  it("places Pi in the single side pane of the split view", () => {
    let state = { settings: { ...settings, rightStack: ["graph"] as Settings["rightStack"] }, dragView: null, graphFull: false };
    const actions = createWorkspaceActions({ get: () => state, set: vi.fn(), commitSettings: (next) => { state = { ...state, settings: next }; }, setSetting: vi.fn() });
    actions.moveViewToRight("agent", 1);
    expect(state.settings.rightStack).toEqual(["agent"]);
  });

  it.each(["empty", "agent"] as const)("keeps a usable workspace when docking Pi from %s", (centerView) => {
    let state = { settings: { ...settings, centerView, rightStack: ["doc", "graph"] } as Settings, dragView: null, graphFull: false };
    const actions = createWorkspaceActions({ get: () => state, set: vi.fn(), commitSettings: (next) => { state = { ...state, settings: next }; }, setSetting: vi.fn() });
    actions.moveViewToRight("agent");
    expect(state.settings).toMatchObject(centerView === "empty" ? { centerView: "agent", rightStack: [] } : { centerView: "doc", rightStack: ["agent"] });
  });

  it("leaves Pi in place when it already fills the workspace alone", () => {
    let state = { settings: { ...settings, centerView: "agent", rightStack: [] } as Settings, dragView: null, graphFull: true };
    const actions = createWorkspaceActions({ get: () => state, set: (patch) => { if (patch.graphFull !== undefined) state.graphFull = patch.graphFull; }, commitSettings: (next) => { state = { ...state, settings: next }; }, setSetting: vi.fn() });
    actions.moveViewToRight("agent");
    expect(state.settings).toMatchObject({ centerView: "agent", rightStack: [] });
    expect(state.graphFull).toBe(false);
  });

  it("moves a dragged view and clears the drag state", () => {
    let state = { settings, dragView: { view: "graph", from: "right", index: 0 } as never, graphFull: false };
    const set = vi.fn((patch) => { state = { ...state, ...patch }; });
    const commitSettings = vi.fn((next) => { state = { ...state, settings: next }; });
    const actions = createWorkspaceActions({ get: () => state, set, commitSettings, setSetting: vi.fn() });
    actions.dropViewInCenter();
    expect(state.dragView).toBeNull();
    expect(commitSettings).toHaveBeenCalled();
  });

  it("does not flip dock side when no right panels exist", () => {
    const state = { settings: { ...settings, rightStack: [] }, dragView: null, graphFull: false };
    const setSetting = vi.fn();
    const actions = createWorkspaceActions({ get: () => state, set: vi.fn(), commitSettings: vi.fn(), setSetting });
    actions.flipDockSide();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("applies named arrangements without changing the user's pane sizes", () => {
    let state = { settings: { ...settings, sidebarWidth: 333, rightWidth: 444 }, dragView: null, graphFull: false };
    const commitSettings = vi.fn((next) => { state = { ...state, settings: next }; });
    const actions = createWorkspaceActions({ get: () => state, set: vi.fn(), commitSettings, setSetting: vi.fn() });
    actions.applyWorkspacePreset("research");
    expect(state.settings).toMatchObject({ centerView: "doc", rightStack: ["agent"], sidebarOpen: true, sidebarAutoHide: false, sidebarWidth: 333, rightWidth: 444 });
  });
});
