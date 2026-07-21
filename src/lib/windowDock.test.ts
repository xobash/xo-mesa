import { describe, expect, it } from "vitest";
import {
  isDockableView,
  normalizeDockWindowPayload,
  shouldDockNativeWindow,
} from "./windowDock";

describe("window dock payloads", () => {
  it("accepts document dock payloads with a usable path", () => {
    expect(normalizeDockWindowPayload({ kind: "doc", relPath: "A/B.md" })).toEqual({
      kind: "doc",
      relPath: "A/B.md",
    });
  });

  it("trims panel rel paths and preserves valid pane views", () => {
    expect(
      normalizeDockWindowPayload({
        kind: "panel",
        view: "preview",
        relPath: " Current.md ",
      })
    ).toEqual({ kind: "panel", view: "preview", relPath: "Current.md" });
  });

  it("accepts the agent dock payload", () => {
    expect(normalizeDockWindowPayload({ kind: "agent" })).toEqual({ kind: "agent" });
  });

  it("rejects malformed payloads", () => {
    expect(normalizeDockWindowPayload(null)).toBeNull();
    expect(normalizeDockWindowPayload({ kind: "doc", relPath: "" })).toBeNull();
    expect(normalizeDockWindowPayload({ kind: "panel", view: "calendar" })).toBeNull();
    expect(normalizeDockWindowPayload({ kind: "other" })).toBeNull();
  });

  it("recognizes every workspace view that can be docked", () => {
    expect(["doc", "preview", "graph", "tasks"].every(isDockableView)).toBe(true);
    expect(isDockableView("calendar")).toBe(false);
  });

  it("requires a deliberate move released over the main window", () => {
    const main = { x: 100, y: 80, width: 1200, height: 800 };
    expect(shouldDockNativeWindow({ initial: { x: 400, y: 200 }, current: { x: 520, y: 260 }, cursor: { x: 700, y: 100 }, main })).toBe(true);
    expect(shouldDockNativeWindow({ initial: { x: 400, y: 200 }, current: { x: 410, y: 205 }, cursor: { x: 700, y: 100 }, main })).toBe(false);
    expect(shouldDockNativeWindow({ initial: { x: 400, y: 200 }, current: { x: 520, y: 260 }, cursor: { x: 40, y: 40 }, main })).toBe(false);
    expect(shouldDockNativeWindow({ initial: { x: 400, y: 200 }, current: { x: 520, y: 260 }, cursor: { x: 700, y: 100 }, main, pointerWasOutsideMain: false })).toBe(false);
  });
});
