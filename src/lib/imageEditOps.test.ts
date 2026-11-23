import { describe, expect, it } from "vitest";
import { composeMatrix, planImageOps, proportionalSize, type ImageOp, type Matrix } from "./imageEditOps";

/** Where the plan's matrix sends source point (x, y): the translation part of the matrix applied after a move to that point. */
const mapPoint = (m: Matrix, x: number, y: number) => composeMatrix(m, [1, 0, 0, 1, x, y]).slice(4);
/** Where a source corner lands, as integer pixel coordinates. */
const corner = (ops: ImageOp[], x: number, y: number, w = 4, h = 2) => mapPoint(planImageOps(w, h, ops).matrix, x, y).map((n) => Math.round(n) + 0);

describe("planImageOps", () => {
  it("rotates right and left with swapped size", () => {
    const right = planImageOps(4, 2, [{ kind: "rotate", turns: 1 }]);
    expect([right.width, right.height]).toEqual([2, 4]);
    expect(corner([{ kind: "rotate", turns: 1 }], 0, 0)).toEqual([2, 0]);
    expect(corner([{ kind: "rotate", turns: -1 }], 0, 0)).toEqual([0, 4]);
  });

  it("returns to the identity after four turns or two flips", () => {
    const turns: ImageOp[] = Array.from({ length: 4 }, () => ({ kind: "rotate", turns: 1 }));
    expect(planImageOps(4, 2, turns).matrix.map((n) => Math.round(n) + 0)).toEqual([1, 0, 0, 1, 0, 0]);
    const flips: ImageOp[] = [{ kind: "flip", axis: "h" }, { kind: "flip", axis: "h" }];
    expect(planImageOps(4, 2, flips).matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("crops after a flip in output coordinates and resizes with smoothing", () => {
    const plan = planImageOps(100, 50, [{ kind: "flip", axis: "h" }, { kind: "crop", x: 10, y: 5, width: 20, height: 10 }, { kind: "resize", width: 40, height: 20 }]);
    expect([plan.width, plan.height, plan.scaled]).toEqual([40, 20, true]);
    // Source pixel (90, 5) is flipped to (10, 5), the crop origin, then scaled.
    expect(mapPoint(plan.matrix, 90, 5)).toEqual([0, 0]);
    expect(planImageOps(100, 50, [{ kind: "rotate", turns: 1 }]).scaled).toBe(false);
  });

  it("rejects crops outside the image, fractional values and oversized results", () => {
    expect(() => planImageOps(10, 10, [{ kind: "crop", x: 5, y: 0, width: 6, height: 5 }])).toThrow(/outside/);
    expect(() => planImageOps(10, 10, [{ kind: "crop", x: 0.5, y: 0, width: 2, height: 2 }])).toThrow(/whole-pixel/);
    expect(() => planImageOps(10, 10, [{ kind: "resize", width: 16_000, height: 16_000 }])).toThrow(/megapixels/);
  });

  it("keeps the aspect ratio for resize", () => {
    expect(proportionalSize(4032, 3024, 1000)).toBe(750);
    expect(proportionalSize(1000, 1, 10)).toBe(1);
  });
});
