import { describe, expect, it } from "vitest";
import { docPanePath, focusDocPane, NO_DOC_SPLIT, openInRegion, openToSide, reconcileDocSplit } from "./docSplit";

describe("side-by-side documents", () => {
  it("opens a second file beside the current one and keeps both visible", () => {
    const step = openToSide({ centerView: "doc", rightStack: ["preview"] }, NO_DOC_SPLIT, "A.md", "B.md");
    expect(step).toEqual({
      placement: { centerView: "doc", rightStack: ["doc2"] },
      split: { active: "doc2", other: "A.md" },
      select: "B.md",
    });
    expect(docPanePath("doc", step.split, "B.md")).toBe("A.md");
    expect(docPanePath("doc2", step.split, "B.md")).toBe("B.md");
  });

  it("opens beside a document shown on the side by using the center", () => {
    const step = openToSide({ centerView: "graph", rightStack: ["doc"] }, NO_DOC_SPLIT, "A.md", "B.md");
    expect(step.placement).toEqual({ centerView: "doc2", rightStack: ["doc"] });
    expect(step.split).toEqual({ active: "doc2", other: "A.md" });
  });

  it("opens normally when there is no current document to keep", () => {
    const step = openToSide({ centerView: "graph", rightStack: [] }, NO_DOC_SPLIT, null, "B.md");
    expect(step).toEqual({ placement: { centerView: "doc", rightStack: [] }, split: NO_DOC_SPLIT, select: "B.md" });
  });

  it("swaps the live editor when the other pane is clicked", () => {
    expect(focusDocPane({ active: "doc2", other: "A.md" }, "B.md", "doc")).toEqual({
      split: { active: "doc", other: "B.md" },
      select: "A.md",
    });
    expect(focusDocPane({ active: "doc2", other: "A.md" }, "B.md", "doc2")).toBeNull();
  });

  it("hands the live editor to the remaining pane when the live pane closes", () => {
    expect(reconcileDocSplit({ centerView: "doc", rightStack: [] }, { active: "doc2", other: "A.md" }))
      .toEqual({ split: { active: "doc", other: null }, select: "A.md" });
    expect(reconcileDocSplit({ centerView: "doc2", rightStack: ["graph"] }, { active: "doc2", other: "A.md" }))
      .toEqual({ split: { active: "doc2", other: null }, select: null });
    expect(reconcileDocSplit({ centerView: "doc", rightStack: ["doc2"] }, { active: "doc2", other: "A.md" })).toBeNull();
  });

  it("opens a dropped file in the pane it was dropped on", () => {
    const split = { active: "doc2" as const, other: "A.md" };
    const both = { centerView: "doc" as const, rightStack: ["doc2" as const] };
    expect(openInRegion(both, split, "B.md", "C.md", "center"))
      .toEqual({ placement: both, split: { active: "doc", other: "B.md" }, select: "C.md" });
    expect(openInRegion(both, split, "B.md", "C.md", "right"))
      .toEqual({ placement: both, split, select: "C.md" });
    expect(openInRegion({ centerView: "doc", rightStack: ["graph"] }, NO_DOC_SPLIT, "A.md", "C.md", "right").placement)
      .toEqual({ centerView: "doc", rightStack: ["doc2"] });
  });

  it("moves a lone document aside instead of replacing it when a file is dropped on it", () => {
    expect(openInRegion({ centerView: "doc", rightStack: [] }, NO_DOC_SPLIT, "Notes.md", "Plan.md", "center")).toEqual({
      placement: { centerView: "doc2", rightStack: ["doc"] },
      split: { active: "doc2", other: "Notes.md" },
      select: "Plan.md",
    });
    expect(openInRegion({ centerView: "doc", rightStack: [] }, NO_DOC_SPLIT, "Notes.md", "Plan.md", "right")).toEqual({
      placement: { centerView: "doc", rightStack: ["doc2"] },
      split: { active: "doc2", other: "Notes.md" },
      select: "Plan.md",
    });
  });

  it("moves a lone panel aside for a dropped file", () => {
    expect(openInRegion({ centerView: "graph", rightStack: [] }, NO_DOC_SPLIT, null, "A.md", "center")).toEqual({
      placement: { centerView: "doc", rightStack: ["graph"] },
      split: NO_DOC_SPLIT,
      select: "A.md",
    });
  });
});
