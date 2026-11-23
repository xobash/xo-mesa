import { IMAGE_EDIT_MAX_PIXELS, IMAGE_EDIT_MAX_SIDE } from "./imageInspect";

/**
 * Image edits as a list of geometric operations. Rotation, flip, crop and
 * resize are all affine, so any sequence composes into one matrix and one
 * draw from the original pixels: no generation loss between steps, undo is
 * dropping the last operation, and memory stays one output canvas.
 */

export type ImageOp =
  | { kind: "rotate"; turns: 1 | -1 }
  | { kind: "flip"; axis: "h" | "v" }
  | { kind: "crop"; x: number; y: number; width: number; height: number }
  | { kind: "resize"; width: number; height: number };

/** Canvas `setTransform` order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface ImagePlan {
  width: number;
  height: number;
  /** Maps source pixels to output pixels. */
  matrix: Matrix;
  /** True when any step scales, so the draw needs smoothing. */
  scaled: boolean;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `outer` applied after `inner`. */
export function composeMatrix(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function isSize(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= IMAGE_EDIT_MAX_SIDE;
}

/** Why `op` cannot apply to a `width` × `height` image, or null. */
export function imageOpProblem(op: ImageOp, width: number, height: number): string | null {
  if (op.kind === "crop") {
    if (![op.x, op.y].every((n) => Number.isInteger(n) && n >= 0) || !isSize(op.width) || !isSize(op.height)) {
      return "Crop needs whole-pixel values of at least 1 pixel.";
    }
    if (op.x + op.width > width || op.y + op.height > height) return "The crop reaches outside the image.";
  }
  if (op.kind === "resize") {
    if (!isSize(op.width) || !isSize(op.height)) return `Width and height must be whole numbers from 1 to ${IMAGE_EDIT_MAX_SIDE}.`;
    if (op.width * op.height > IMAGE_EDIT_MAX_PIXELS) return `The result would exceed ${IMAGE_EDIT_MAX_PIXELS / 1_000_000} megapixels.`;
  }
  return null;
}

/** Compose `ops` on a source of the given size. Throws on an invalid step. */
export function planImageOps(sourceWidth: number, sourceHeight: number, ops: readonly ImageOp[]): ImagePlan {
  let width = sourceWidth;
  let height = sourceHeight;
  let matrix = IDENTITY;
  let scaled = false;
  for (const op of ops) {
    const problem = imageOpProblem(op, width, height);
    if (problem) throw new Error(problem);
    let step: Matrix;
    if (op.kind === "rotate") {
      step = op.turns === 1 ? [0, 1, -1, 0, height, 0] : [0, -1, 1, 0, 0, width];
      [width, height] = [height, width];
    } else if (op.kind === "flip") {
      step = op.axis === "h" ? [-1, 0, 0, 1, width, 0] : [1, 0, 0, -1, 0, height];
    } else if (op.kind === "crop") {
      step = [1, 0, 0, 1, -op.x, -op.y];
      width = op.width;
      height = op.height;
    } else {
      step = [op.width / width, 0, 0, op.height / height, 0, 0];
      scaled ||= op.width !== width || op.height !== height;
      width = op.width;
      height = op.height;
    }
    matrix = composeMatrix(step, matrix);
  }
  return { width, height, matrix, scaled };
}

/** A resize height that keeps the aspect ratio, at least 1 pixel. */
export function proportionalSize(width: number, height: number, newWidth: number): number {
  return Math.max(1, Math.round((height * newWidth) / width));
}
