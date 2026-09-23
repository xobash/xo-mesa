import { describe, it, expect } from "vitest";
import {
  togglePanel,
  removeView,
  placeView,
  placeInCenter,
  placeInRight,
  closeCenterView,
  fillWorkspace,
  hitWorkspaceRegion,
  removeFromWorkspace,
  toggleWorkspacePanel,
  openViewInWorkspace,
} from "./panes";

describe("togglePanel", () => {
  it("adds when absent, removes when present", () => {
    expect(togglePanel(["preview"], "graph")).toEqual(["preview", "graph"]);
    expect(togglePanel(["preview", "graph"], "graph")).toEqual(["preview"]);
  });
});

describe("removePanel", () => {
  it("removes a panel, no-op if absent", () => {
    expect(removeView(["preview", "graph"], "preview")).toEqual(["graph"]);
    expect(removeView(["graph"], "preview")).toEqual(["graph"]);
  });
  it("removes the editor view when it is docked on the right", () => {
    expect(removeView(["preview", "doc", "graph"], "doc")).toEqual([
      "preview",
      "graph",
    ]);
  });
});

describe("placePanel", () => {
  it("inserts at an index", () => {
    expect(placeView(["preview", "tasks"], "graph", 1)).toEqual([
      "preview",
      "graph",
      "tasks",
    ]);
  });
  it("moves an existing panel (dedupes) to the new index", () => {
    expect(placeView(["preview", "graph", "tasks"], "tasks", 0)).toEqual([
      "tasks",
      "preview",
      "graph",
    ]);
  });
  it("clamps the index to the ends", () => {
    expect(placeView(["preview"], "graph", 99)).toEqual(["preview", "graph"]);
    expect(placeView(["preview"], "graph", -5)).toEqual(["graph", "preview"]);
  });
});

describe("region placement", () => {
  it("swaps a right-side panel into the center and moves the editor right", () => {
    expect(placeInCenter("doc", ["preview", "graph"], "graph")).toEqual({
      centerView: "graph",
      rightStack: ["preview", "doc"],
    });
  });

  it("moves the document view back from the right into the center", () => {
    expect(placeInCenter("graph", ["preview", "doc"], "doc")).toEqual({
      centerView: "doc",
      rightStack: ["preview", "graph"],
    });
  });

  it("moves the center view into the right stack and promotes the first right view", () => {
    expect(placeInRight("doc", ["preview", "graph"], "doc", 1)).toEqual({
      centerView: "preview",
      rightStack: ["graph", "doc"],
    });
  });

  it("moves the editor into an empty right stack and keeps the center usable", () => {
    expect(placeInRight("doc", [], "doc", 0)).toEqual({
      centerView: "empty",
      rightStack: ["doc"],
    });
  });

  it("reorders a non-center view inside the right stack", () => {
    expect(placeInRight("doc", ["preview", "graph"], "graph", 0)).toEqual({
      centerView: "doc",
      rightStack: ["graph", "preview"],
    });
  });

  it("closes the center editor without promoting another view", () => {
    expect(closeCenterView("doc", ["preview", "graph"])).toEqual({
      centerView: "preview",
      rightStack: ["graph"],
    });
  });

  it("closes the center editor even when the right stack is empty", () => {
    expect(closeCenterView("doc", [])).toEqual({
      centerView: "empty",
      rightStack: [],
    });
  });

  it("moves a right pane into an empty center without adding an empty pane right", () => {
    expect(placeInCenter("empty", ["preview", "graph"], "graph")).toEqual({
      centerView: "graph",
      rightStack: ["preview"],
    });
  });

  it("fills an empty center with the first right-side view", () => {
    expect(fillWorkspace("empty", ["graph", "tasks"])).toEqual({
      centerView: "graph",
      rightStack: ["tasks"],
    });
  });

  it("removes a right-side view and promotes another when center is empty", () => {
    expect(removeFromWorkspace("empty", ["preview", "graph"], "preview")).toEqual({
      centerView: "graph",
      rightStack: [],
    });
  });

  it("opens the first toggled panel into an empty workspace before stacking", () => {
    const first = toggleWorkspacePanel("empty", [], "preview");
    expect(first).toEqual({ centerView: "preview", rightStack: [] });
    expect(toggleWorkspacePanel(first.centerView, first.rightStack, "graph")).toEqual({
      centerView: "preview",
      rightStack: ["graph"],
    });
  });

  it("claims the full workspace for the first open view even if stale stack entries exist", () => {
    expect(openViewInWorkspace("empty", ["preview"], "graph")).toEqual({
      centerView: "graph",
      rightStack: [],
    });
    expect(toggleWorkspacePanel("empty", ["preview"], "tasks")).toEqual({
      centerView: "tasks",
      rightStack: [],
    });
  });

  it("opens or spawns the first view into the whole empty workspace", () => {
    expect(openViewInWorkspace("empty", [], "graph")).toEqual({
      centerView: "graph",
      rightStack: [],
    });
    expect(openViewInWorkspace("empty", [], "doc")).toEqual({
      centerView: "doc",
      rightStack: [],
    });
  });

  it("opens or spawns additional views only after the workspace is occupied", () => {
    expect(openViewInWorkspace("preview", [], "graph")).toEqual({
      centerView: "preview",
      rightStack: ["graph"],
    });
    expect(openViewInWorkspace("preview", ["graph"], "graph")).toEqual({
      centerView: "preview",
      rightStack: ["graph"],
    });
  });

  it("removes toggled panels from either workspace region", () => {
    expect(toggleWorkspacePanel("preview", ["graph"], "preview")).toEqual({
      centerView: "graph",
      rightStack: [],
    });
    expect(toggleWorkspacePanel("preview", ["graph"], "graph")).toEqual({
      centerView: "preview",
      rightStack: [],
    });
  });

  it("detects right-region drops by coordinates even when element lookup is obscured", () => {
    const center = { left: 200, top: 0, right: 799, bottom: 600 };
    const right = { left: 800, top: 0, right: 1200, bottom: 600 };
    expect(hitWorkspaceRegion(900, 200, center, right)).toBe("right");
    expect(hitWorkspaceRegion(300, 200, center, right)).toBe("center");
    expect(hitWorkspaceRegion(20, 200, center, right)).toBeNull();
  });
});
