/**
 * A d3-quadtree 3.0.1 tree in flat arrays: the same extent, insertion and
 * splitting, with each quad's box stored as d3's visit would compute it.
 * Shared by the many-body kernel and the collide force (`graphForces.ts`).
 */
/** One reusable quadtree; arrays grow by doubling and are kept between ticks. */
export class FlatQuadtree {
  kids = new Int32Array(0);
  /** Leaf: head point index of its coincident chain; internal node: -1. */
  head = new Int32Array(0);
  next = new Int32Array(0);
  /** Per-quad accumulators: charge value and centre, or collide max radius. */
  value = new Float64Array(0);
  cx = new Float64Array(0);
  cy = new Float64Array(0);
  /** Each quad's box, computed with the same midpoints d3's visit uses. */
  bx0 = new Float64Array(0);
  by0 = new Float64Array(0);
  bx1 = new Float64Array(0);
  by1 = new Float64Array(0);
  count = 0;
  internals: number[] = [];
  root = -1;
  x0 = 0; y0 = 0; x1 = 0; y1 = 0;
  /** Pre-order visit stack of quad ids. */
  stack = new Int32Array(0);

  private alloc(head: number, x0: number, y0: number, x1: number, y1: number): number {
    if (this.count === this.head.length) this.grow(Math.max(64, this.head.length * 2));
    const id = this.count++;
    this.head[id] = head;
    this.kids.fill(-1, id * 4, id * 4 + 4);
    this.bx0[id] = x0; this.by0[id] = y0; this.bx1[id] = x1; this.by1[id] = y1;
    if (head < 0) this.internals.push(id);
    return id;
  }

  private grow(capacity: number): void {
    const kids = new Int32Array(capacity * 4); kids.set(this.kids); this.kids = kids;
    const head = new Int32Array(capacity); head.set(this.head); this.head = head;
    const value = new Float64Array(capacity); value.set(this.value); this.value = value;
    const cx = new Float64Array(capacity); cx.set(this.cx); this.cx = cx;
    const cy = new Float64Array(capacity); cy.set(this.cy); this.cy = cy;
    const bx0 = new Float64Array(capacity); bx0.set(this.bx0); this.bx0 = bx0;
    const by0 = new Float64Array(capacity); by0.set(this.by0); this.by0 = by0;
    const bx1 = new Float64Array(capacity); bx1.set(this.bx1); this.bx1 = bx1;
    const by1 = new Float64Array(capacity); by1.set(this.by1); this.by1 = by1;
  }

  /** d3-quadtree `quadtree().addAll(points)`: same extent, same insertion. */
  build(xs: Float64Array, ys: Float64Array, n: number): void {
    this.count = 0;
    this.internals.length = 0;
    this.root = -1;
    if (this.next.length < n) this.next = new Int32Array(n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i];
      if (isNaN(x) || isNaN(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX || minY > maxY) return;
    this.cover(minX, minY, maxX, maxY);
    for (let i = 0; i < n; i++) this.add(xs, ys, i);
  }

  /** `cover(min).cover(max)` on an empty tree: integer origin, doubled size. */
  private cover(minX: number, minY: number, maxX: number, maxY: number): void {
    let x0 = Math.floor(minX), y0 = Math.floor(minY), x1 = x0 + 1, y1 = y0 + 1;
    if (isNaN(maxX) || isNaN(maxY)) { this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1; return; }
    let z = x1 - x0 || 1;
    // Each pass doubles z; finite coordinates need at most about 2,100 passes.
    for (let guard = 0; (x0 > maxX || maxX >= x1 || y0 > maxY || maxY >= y1) && guard < 4096; guard++) {
      const i = (+(maxY < y0) << 1) | +(maxX < x0);
      z *= 2;
      if (i === 0) { x1 = x0 + z; y1 = y0 + z; }
      else if (i === 1) { x0 = x1 - z; y1 = y0 + z; }
      else if (i === 2) { x1 = x0 + z; y0 = y1 - z; }
      else { x0 = x1 - z; y0 = y1 - z; }
    }
    this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
  }

  private add(xs: Float64Array, ys: Float64Array, p: number): void {
    const x = xs[p], y = ys[p];
    if (isNaN(x) || isNaN(y)) return;
    this.next[p] = -1;
    if (this.root < 0) { this.root = this.alloc(p, this.x0, this.y0, this.x1, this.y1); return; }
    let x0 = this.x0, y0 = this.y0, x1 = this.x1, y1 = this.y1;
    let node = this.root, parent = -1, i = 0, xm = 0, ym = 0;
    while (this.head[node] < 0) {
      const right = x >= (xm = (x0 + x1) / 2); if (right) x0 = xm; else x1 = xm;
      const bottom = y >= (ym = (y0 + y1) / 2); if (bottom) y0 = ym; else y1 = ym;
      parent = node;
      i = (+bottom << 1) | +right;
      node = this.kids[parent * 4 + i];
      if (node < 0) { const leaf = this.alloc(p, x0, y0, x1, y1); this.kids[parent * 4 + i] = leaf; return; }
    }
    const first = this.head[node], xp = xs[first], yp = ys[first];
    if (x === xp && y === yp) { this.next[p] = first; this.head[node] = p; return; }
    let j = 0, px0 = x0, py0 = y0, px1 = x1, py1 = y1;
    // Each split halves the box; doubles separate within about 2,100 splits.
    for (let guard = 0; guard < 4096; guard++) {
      const inner = this.alloc(-1, x0, y0, x1, y1);
      if (parent >= 0) this.kids[parent * 4 + i] = inner; else this.root = inner;
      parent = inner;
      px0 = x0; py0 = y0; px1 = x1; py1 = y1;
      const right = x >= (xm = (x0 + x1) / 2); if (right) x0 = xm; else x1 = xm;
      const bottom = y >= (ym = (y0 + y1) / 2); if (bottom) y0 = ym; else y1 = ym;
      i = (+bottom << 1) | +right;
      j = (+(yp >= ym) << 1) | +(xp >= xm);
      if (i !== j) break;
    }
    // The old leaf moves to quadrant j of the new parent.
    this.kids[parent * 4 + j] = node;
    if (j & 1) { this.bx0[node] = xm; this.bx1[node] = px1; } else { this.bx0[node] = px0; this.bx1[node] = xm; }
    if (j & 2) { this.by0[node] = ym; this.by1[node] = py1; } else { this.by0[node] = py0; this.by1[node] = ym; }
    const leaf = this.alloc(p, x0, y0, x1, y1);
    this.kids[parent * 4 + i] = leaf;
  }

  ensureStack(): void {
    // A pre-order visit holds at most 3 siblings per level plus one.
    const need = this.count * 3 + 4;
    if (this.stack.length < need) this.stack = new Int32Array(need);
  }
}

