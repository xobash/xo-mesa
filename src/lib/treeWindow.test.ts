import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROW_HEIGHT,
  focusRowRange,
  scrollTopForRow,
  visibleRowRange,
  windowedRowIndices,
} from "./treeWindow";

const view = {
  scrollTop: 0,
  offset: 0,
  viewportHeight: 600,
  rowHeight: DEFAULT_ROW_HEIGHT,
};

describe("visibleRowRange", () => {
  it("covers the viewport plus overscan on both edges", () => {
    const r = visibleRowRange(4165, { ...view, scrollTop: 1000, overscan: 8 });
    // 1000/23 = 43.4 -> first visible 43; 1600/23 = 69.5 -> last 70
    expect(r.start).toBe(43 - 8);
    expect(r.end).toBe(70 + 8);
  });

  it("never returns indices outside the row list", () => {
    expect(visibleRowRange(10, { ...view, scrollTop: 0 })).toEqual({
      start: 0,
      end: 10,
    });
    expect(visibleRowRange(4165, { ...view, scrollTop: 10_000_000 })).toEqual({
      start: 4165,
      end: 4165,
    });
  });

  it("subtracts the content above the tree from the scroll position", () => {
    const withoutOffset = visibleRowRange(4165, { ...view, scrollTop: 1000 });
    const withOffset = visibleRowRange(4165, {
      ...view,
      scrollTop: 1000 + 230,
      offset: 230,
    });
    expect(withOffset).toEqual(withoutOffset);
  });

  it("renders nothing rather than dividing by zero when unmeasured", () => {
    expect(visibleRowRange(4165, { ...view, rowHeight: 0 })).toEqual({
      start: 0,
      end: 0,
    });
    expect(visibleRowRange(4165, { ...view, viewportHeight: 0 })).toEqual({
      start: 0,
      end: 0,
    });
    expect(visibleRowRange(0, view)).toEqual({ start: 0, end: 0 });
  });

  it("renders every row when the viewport is unbounded", () => {
    // `FileTree` uses this when the tree has no scrollable ancestor: nothing
    // can be off-screen, so an unwindowed tree is the correct fallback.
    expect(
      visibleRowRange(4165, { ...view, viewportHeight: Number.POSITIVE_INFINITY })
    ).toEqual({ start: 0, end: 4165 });
  });

  it("windows a real vault down to a viewport-sized slice", () => {
    const r = visibleRowRange(4165, { ...view, scrollTop: 50_000 });
    expect(r.end - r.start).toBeLessThan(60);
  });
});

describe("focusRowRange", () => {
  it("keeps the focused row and its Tab neighbours rendered", () => {
    expect(focusRowRange(100, 4165)).toEqual({ start: 99, end: 102 });
  });

  it("clamps at the ends of the list", () => {
    expect(focusRowRange(0, 10)).toEqual({ start: 0, end: 2 });
    expect(focusRowRange(9, 10)).toEqual({ start: 8, end: 10 });
  });

  it("is null when nothing in the tree has focus", () => {
    expect(focusRowRange(null, 10)).toBeNull();
    expect(focusRowRange(-1, 10)).toBeNull();
    expect(focusRowRange(10, 10)).toBeNull();
  });
});

describe("windowedRowIndices", () => {
  it("returns the viewport rows when nothing has focus", () => {
    expect(windowedRowIndices({ start: 2, end: 5 }, null)).toEqual([2, 3, 4]);
  });

  it("adds a far-away focused row without filling the gap between", () => {
    const idx = windowedRowIndices({ start: 0, end: 3 }, { start: 999, end: 1002 });
    expect(idx).toEqual([0, 1, 2, 999, 1000, 1001]);
  });

  it("never duplicates a row that is both focused and visible", () => {
    const idx = windowedRowIndices({ start: 0, end: 5 }, { start: 1, end: 4 });
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("scrollTopForRow", () => {
  it("leaves a row that is already visible alone", () => {
    expect(scrollTopForRow(5, { ...view, scrollTop: 0 })).toBeNull();
  });

  it("scrolls a row above the viewport to the top edge", () => {
    expect(scrollTopForRow(10, { ...view, scrollTop: 1000 })).toBe(230);
  });

  it("scrolls a row below the viewport to the bottom edge", () => {
    // row 100 spans 2300..2323; viewport is 600 tall at scrollTop 0
    expect(scrollTopForRow(100, { ...view, scrollTop: 0 })).toBe(2323 - 600);
  });

  it("accounts for content above the tree", () => {
    expect(scrollTopForRow(10, { ...view, scrollTop: 1000, offset: 200 })).toBe(
      430
    );
  });

  it("never scrolls above the top of the container", () => {
    expect(scrollTopForRow(0, { ...view, scrollTop: 100 })).toBe(0);
  });

  it("declines to scroll when the tree has not been measured", () => {
    expect(scrollTopForRow(3, { ...view, rowHeight: 0 })).toBeNull();
    expect(scrollTopForRow(-1, view)).toBeNull();
  });
});
