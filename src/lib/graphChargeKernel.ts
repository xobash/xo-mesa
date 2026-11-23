import { FlatQuadtree } from "./graphQuadtree";

/**
 * The Barnes-Hut many-body pass of `flatManyBody` (d3-force 3.0.0), split so
 * any range of nodes can be applied on its own: each node's velocity change
 * reads only positions, its own starting velocity and the shared tree, so
 * ranges applied in different workers give bit-identical results. A jiggle
 * (two points exactly coincident) draws from the simulation's random source;
 * a range that needs one reports it, and the caller redoes the pass serially.
 */
export class ChargeKernel {
  readonly tree = new FlatQuadtree();
  xs = new Float64Array(0);
  ys = new Float64Array(0);
  vx = new Float64Array(0);
  vy = new Float64Array(0);
  strengths: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private open = new Float64Array(0);
  distanceMin2 = 1;
  distanceMax2 = Infinity;
  theta2 = 0.81;
  n = 0;

  /** Size the arrays for `n` nodes; callers fill xs, ys, vx, vy and strengths. */
  reserve(n: number): void {
    this.n = n;
    if (this.xs.length < n) {
      this.xs = new Float64Array(n); this.ys = new Float64Array(n);
      this.vx = new Float64Array(n); this.vy = new Float64Array(n);
    }
  }

  /** Build the tree over xs, ys and accumulate charges and opening thresholds. False when empty. */
  prepare(): boolean {
    const tree = this.tree;
    tree.build(this.xs, this.ys, this.n);
    if (tree.root < 0) return false;
    const { head, next, kids, value, cx, cy } = tree;
    const { xs, ys, strengths } = this;
    for (let q = 0; q < tree.count; q++) {
      const first = head[q];
      if (first < 0) continue;
      let s = 0;
      cx[q] = xs[first]; cy[q] = ys[first];
      for (let p = first; p >= 0; p = next[p]) s += strengths[p];
      value[q] = s;
    }
    // Internal quads are created after their internal parents: reverse order
    // finishes every child first.
    const internals = tree.internals;
    for (let k = internals.length - 1; k >= 0; k--) {
      const q = internals[k];
      let s = 0, weight = 0, x = 0, y = 0;
      for (let i = 0; i < 4; i++) {
        const c = kids[q * 4 + i];
        if (c < 0) continue;
        const w = Math.abs(value[c]);
        if (w) { s += value[c]; weight += w; x += w * cx[c]; y += w * cy[c]; }
      }
      cx[q] = x / weight; cy[q] = y / weight;
      value[q] = s;
    }
    if (this.open.length < tree.count) this.open = new Float64Array(tree.head.length);
    for (let q = 0; q < tree.count; q++) { const w = tree.bx1[q] - tree.bx0[q]; this.open[q] = w * w / this.theta2; }
    tree.ensureStack();
    return true;
  }

  /**
   * Apply nodes `from` to `to` (exclusive). `random` is called only for a
   * jiggle; a worker passes one that records the need instead.
   */
  applyRange(from: number, to: number, alpha: number, random: () => number): void {
    for (let i = from; i < to; i++) this.applyTo(i, alpha, random);
  }

  private applyTo(i: number, alpha: number, random: () => number): void {
    const { head, next, kids, value, cx, cy, stack } = this.tree;
    const { xs, ys, vx, vy, strengths, open, distanceMin2, distanceMax2 } = this;
    const jiggle = () => (random() - 0.5) * 1e-6;
    const nx = xs[i], ny = ys[i];
    let fx = vx[i], fy = vy[i];
    stack[0] = this.tree.root;
    let top = 1;
    while (top > 0) {
      const q = stack[--top];
      if (!value[q]) continue;
      let x = cx[q] - nx, y = cy[q] - ny, l = x * x + y * y;
      const first = head[q];
      if (open[q] < l) {
        if (l < distanceMax2) {
          if (x === 0) { x = jiggle(); l += x * x; }
          if (y === 0) { y = jiggle(); l += y * y; }
          if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
          fx += x * value[q] * alpha / l;
          fy += y * value[q] * alpha / l;
        }
        continue;
      }
      if (first < 0) {
        // An internal quad is opened even beyond distanceMax, as in d3.
        const k = q * 4;
        let c = kids[k + 3]; if (c >= 0) stack[top++] = c;
        c = kids[k + 2]; if (c >= 0) stack[top++] = c;
        c = kids[k + 1]; if (c >= 0) stack[top++] = c;
        c = kids[k]; if (c >= 0) stack[top++] = c;
        continue;
      }
      if (l >= distanceMax2) continue;
      if (first !== i || next[first] >= 0) {
        if (x === 0) { x = jiggle(); l += x * x; }
        if (y === 0) { y = jiggle(); l += y * y; }
        if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
      }
      for (let p = first; p >= 0; p = next[p]) {
        if (p === i) continue;
        const w = strengths[p] * alpha / l;
        fx += x * w;
        fy += y * w;
      }
    }
    vx[i] = fx; vy[i] = fy;
  }
}
