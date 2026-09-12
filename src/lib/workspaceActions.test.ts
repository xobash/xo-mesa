import { describe, expect, it, vi } from "vitest";
import { createWorkspaceActions } from "./workspaceActions";
import type { Settings } from "../types";

const settings = { centerView: "doc", rightStack: ["tasks"], dockSide: "right" } as Settings;

describe("workspace action domain", () => {
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
    let state = { settings: { ...settings, rightStack: [] }, dragView: null, graphFull: false };
    const setSetting = vi.fn();
    const actions = createWorkspaceActions({ get: () => state, set: vi.fn(), commitSettings: vi.fn(), setSetting });
    actions.flipDockSide();
    expect(setSetting).not.toHaveBeenCalled();
  });
});
