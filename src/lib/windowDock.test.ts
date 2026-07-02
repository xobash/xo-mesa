import { describe, expect, it } from "vitest";
import {
  isDockableView,
  normalizeDockWindowPayload,
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
});
