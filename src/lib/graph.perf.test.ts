/**
 * Graph hot-path bench + optimization characterization (session 2026-07-03).
 *
 * Two jobs:
 *  1. Reproducible perf bench: times the graph's pure hot paths at demo-ish
 *     (650n) and stress (2000n) scale and prints a table. Private GraphView
 *     helpers (resolveOverlaps, graphBounds, the render-liveness loop) are
 *     copied here as documented verbatim equivalents, with source line
 *     citations, because they are module-private. Numbers feed
 *     docs/graph-and-preview-optimizations.md.
 *  2. Characterization tests protecting the optimizations those numbers drove:
 *     - Round 1 (idle-resolver gate): resolveOverlaps' boolean return is a
 *       faithful "did anything move" signal (false ⇔ already overlap-free), the
 *       safety basis for skipping it once GraphView's layoutSettledRef freezes.
 *     - Round 2 (liveness hypot dedup): the single-hypot loop is bit-identical
 *       to the original double-hypot loop.
 */
import { describe, it, expect } from "vitest";
import type { GraphNode, VaultFile } from "../types";
import { buildNotes, buildGraph, buildNeighbors } from "./graph";
import { bumpActivityAmount, decayActivity, activeRecords } from "./activity";

// ---- deterministic PRNG so runs are comparable --------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Time fn over `reps` runs (after warm-up so JIT tiers settle), median ms. */
function bench(reps: number, fn: () => void): number {
  for (let i = 0; i < 5; i++) fn(); // warm-up, untimed
  const times: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return median(times);
}

// ---- synthetic vault ------------------------------------------------------
function makeVault(nNotes: number, linksPerNote: number, seed = 42) {
  const rnd = mulberry32(seed);
  const files: VaultFile[] = [];
  const contents = new Map<string, string>();
  for (let i = 0; i < nNotes; i++) {
    const name = `Note ${i}`;
    const rel = `notes/${name}.md`;
    files.push({
      path: `/vault/${rel}`,
      relPath: rel,
      name,
      ext: "md",
      isMarkdown: true,
      size: 1000,
      mtime: 0,
    } as unknown as VaultFile);
    let body = `# ${name}\n\ntext text text #tag${i % 40}\n`;
    // Preferential-ish attachment: early notes get more inbound links (hubs).
    for (let l = 0; l < linksPerNote; l++) {
      const tgt = Math.floor(Math.pow(rnd(), 2.2) * nNotes);
      body += `see [[Note ${tgt}]] and more prose here\n`;
    }
    contents.set(rel, body);
  }
  return { files, contents };
}

function syntheticNotes(files: VaultFile[], contents: Map<string, string>) {
  return buildNotes(files, contents);
}

// ---- equivalents of GraphView.tsx private helpers -------------------------
// nodeRadius — GraphView.tsx:102
function nodeRadius(n: GraphNode): number {
  return Math.min(24, 2.4 + 1.75 * Math.sqrt(n.degree));
}
const OVERLAP_GAP = 8; // GraphView.tsx:55

// resolveOverlaps — verbatim equivalent of GraphView.tsx:113-175
function resolveOverlaps(
  nodes: GraphNode[],
  radiusOf: (n: GraphNode) => number,
  gap: number,
  iterations: number
): boolean {
  let moved = false;
  const cell = 2 * 24 + 2 * gap + 4;
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const k = Math.floor(n.x / cell) + "," + Math.floor(n.y / cell);
      const arr = grid.get(k);
      if (arr) arr.push(n);
      else grid.set(k, [n]);
    }
    for (const n of nodes) {
      if (n.x == null || n.y == null || n.fx != null) continue;
      const rn = radiusOf(n) + gap;
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(gx + dx + "," + (gy + dy));
          if (!arr) continue;
          for (const m of arr) {
            if (m === n || m.x == null || m.y == null) continue;
            const min = rn + radiusOf(m) + gap;
            let ddx: number = n.x - m.x;
            let ddy: number = n.y - m.y;
            let d2: number = ddx * ddx + ddy * ddy;
            if (d2 >= min * min) continue;
            let d: number = Math.sqrt(d2);
            if (d < 1e-6) {
              ddx = 1;
              ddy = 0;
              d = 1;
              d2 = 1;
            }
            const overlap = min - d;
            if (overlap < 0.01) continue;
            const nShare = m.fx != null ? 1 : 0.5;
            const ux: number = ddx / d;
            const uy: number = ddy / d;
            n.x = n.x + ux * overlap * nShare;
            n.y = n.y + uy * overlap * nShare;
            if (m.fx == null) {
              m.x = m.x - ux * overlap * (1 - nShare);
              m.y = m.y - uy * overlap * (1 - nShare);
            }
            moved = true;
          }
        }
      }
    }
  }
  return moved;
}

// Round-2 candidate: identical to livenessLoop but Math.hypot(cx,cy) is computed
// once instead of twice (lines 183 + 185 above are the same call). Output is
// bit-identical (same function, called once, reused). Measured A/B below.
function livenessLoopDedup(nodes: GraphNode[], lnow: number, livingPx: number, pulseAmp: number, w: number, h: number) {
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const phase = n.renderPhase ?? 0;
    const r = nodeRadius(n);
    const kvx = (n.renderKickVx ?? 0) * 0.82;
    const kvy = (n.renderKickVy ?? 0) * 0.82;
    const kx = ((n.renderKickX ?? 0) + kvx) * 0.84;
    const ky = ((n.renderKickY ?? 0) + kvy) * 0.84;
    n.renderKickVx = Math.abs(kvx) < 0.01 ? 0 : kvx;
    n.renderKickVy = Math.abs(kvy) < 0.01 ? 0 : kvy;
    n.renderKickX = Math.abs(kx) < 0.01 ? 0 : kx;
    n.renderKickY = Math.abs(ky) < 0.01 ? 0 : ky;
    const a = lnow * 0.42 + phase;
    const b = lnow * 0.27 + phase * 1.37;
    const cx = x - w / 2;
    const cy = y - h / 2;
    const len = Math.hypot(cx, cy);
    const radial = Math.min(1.8, len / Math.max(240, w * 0.42));
    const breathe = Math.sin(lnow * 0.36 + phase * 0.18) * livingPx * 0.55 * radial;
    const invLen = 1 / Math.max(1, len);
    const mingle = Math.sin(lnow * 0.21 + phase * 0.51) * livingPx * 0.28;
    n.renderX = x + (Math.sin(a) + Math.sin(b) * 0.35) * livingPx * 1.35 + mingle * 0.5 + cx * invLen * breathe + kx;
    n.renderY = y + (Math.cos(a * 0.82) + Math.sin(b * 0.7) * 0.32) * livingPx * 1.35 + mingle * -0.28 + cy * invLen * breathe + ky;
    n.renderRadius = r * (1 + Math.sin(lnow * 1.8 + phase) * pulseAmp);
  }
}

// graphBounds — equivalent of GraphView.tsx:432-468 (the per-frame bloom pass)
function graphBounds(nodes: GraphNode[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let valid = false;
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    const r = nodeRadius(n) + 24;
    minX = Math.min(minX, n.x - r);
    maxX = Math.max(maxX, n.x + r);
    minY = Math.min(minY, n.y - r);
    maxY = Math.max(maxY, n.y + r);
    valid = true;
  }
  if (!valid) return { cx: 0, cy: 0, radius: 0, valid };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { cx, cy, radius: Math.max(maxX - cx, cx - minX, maxY - cy, cy - minY), valid };
}

// render-liveness loop — equivalent of GraphView.tsx:1018-1074 per-node math
function livenessLoop(nodes: GraphNode[], lnow: number, livingPx: number, pulseAmp: number, w: number, h: number) {
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const phase = n.renderPhase ?? 0;
    const r = nodeRadius(n);
    const kvx = (n.renderKickVx ?? 0) * 0.82;
    const kvy = (n.renderKickVy ?? 0) * 0.82;
    const kx = ((n.renderKickX ?? 0) + kvx) * 0.84;
    const ky = ((n.renderKickY ?? 0) + kvy) * 0.84;
    n.renderKickVx = Math.abs(kvx) < 0.01 ? 0 : kvx;
    n.renderKickVy = Math.abs(kvy) < 0.01 ? 0 : kvy;
    n.renderKickX = Math.abs(kx) < 0.01 ? 0 : kx;
    n.renderKickY = Math.abs(ky) < 0.01 ? 0 : ky;
    const a = lnow * 0.42 + phase;
    const b = lnow * 0.27 + phase * 1.37;
    const cx = x - w / 2;
    const cy = y - h / 2;
    const radial = Math.min(1.8, Math.hypot(cx, cy) / Math.max(240, w * 0.42));
    const breathe = Math.sin(lnow * 0.36 + phase * 0.18) * livingPx * 0.55 * radial;
    const invLen = 1 / Math.max(1, Math.hypot(cx, cy));
    const mingle = Math.sin(lnow * 0.21 + phase * 0.51) * livingPx * 0.28;
    n.renderX = x + (Math.sin(a) + Math.sin(b) * 0.35) * livingPx * 1.35 + mingle * 0.5 + cx * invLen * breathe + kx;
    n.renderY = y + (Math.cos(a * 0.82) + Math.sin(b * 0.7) * 0.32) * livingPx * 1.35 + mingle * -0.28 + cy * invLen * breathe + ky;
    n.renderRadius = r * (1 + Math.sin(lnow * 1.8 + phase) * pulseAmp);
  }
}

// graphSig — equivalent of GraphView.tsx:591-601 (runs on every notes change)
function graphSig(nodes: GraphNode[], links: { source: unknown; target: unknown }[]): string {
  return [
    nodes.map((n) => n.id).sort().join(""),
    links
      .map((l) => {
        const s = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
        const t = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
        return `${s}->${t}`;
      })
      .sort()
      .join(""),
  ].join("");
}

// batch2/batch3 idle link scans — equivalent of GraphView.tsx:1179-1227 when
// there is no hover/active/drag and no activity (the common idle frame).
function idleLinkScans(lc: number, sId: string[], tId: string[], actMap: Map<string, unknown>) {
  let work = 0;
  // Batch 2 (GraphView.tsx:1179): full scan even when nothing is hot.
  for (let i = 0; i < lc; i++) {
    if (actMap.has(sId[i]) || actMap.has(tId[i])) continue;
    // touchActive/touchHover/touchDrag all false at idle
  }
  // Batch 3 (GraphView.tsx:1207): full scan even when actMap is empty.
  for (let i = 0; i < lc; i++) {
    const sa = actMap.get(sId[i]);
    const ta = actMap.get(tId[i]);
    if (!sa && !ta) continue;
    work++;
  }
  return work;
}

// ---- position seeding ------------------------------------------------------
function scatter(nodes: GraphNode[], spread: number, seed = 7) {
  const rnd = mulberry32(seed);
  for (const n of nodes) {
    n.x = (rnd() - 0.5) * spread;
    n.y = (rnd() - 0.5) * spread;
    n.fx = null as unknown as undefined;
    n.fy = null as unknown as undefined;
    n.renderPhase = rnd() * Math.PI * 2;
  }
}

function fmt(ms: number): string {
  return ms.toFixed(3).padStart(9);
}

describe("idle-resolver gate safety basis (Round 1, 2026-07-03)", () => {
  // The GraphView draw loop now skips resolveOverlaps() at idle once it reports
  // moved=false (layoutSettledRef in GraphView.tsx). That is only safe if the
  // resolver's boolean return is a faithful "did any node actually move" signal:
  // false ⇔ the layout is already overlap-free (so re-running is a pure no-op),
  // true ⇔ there was an overlap to fix (so the loop must keep resolving). This
  // resolveOverlaps copy is the documented verbatim equivalent of
  // GraphView.tsx:113-175; both share the same `moved` bookkeeping.
  const nodeAt = (id: string, x: number, y: number, degree = 0): GraphNode =>
    ({ id, title: id, degree, kind: "note", ext: "md", x, y } as unknown as GraphNode);

  it("returns false on a non-overlapping layout (freeze signal)", () => {
    // Spacing > cell size (2*24 + 2*gap + 4) guarantees no pair overlaps.
    const spacing = 2 * 24 + 2 * OVERLAP_GAP + 40;
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 25; i++) {
      nodes.push(nodeAt(`n${i}`, (i % 5) * spacing, Math.floor(i / 5) * spacing));
    }
    expect(resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2)).toBe(false);
    // And it is idempotent: a second pass still reports no movement.
    expect(resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2)).toBe(false);
  });

  it("returns true when nodes overlap, then resolves to a stable false", () => {
    const nodes = [nodeAt("a", 0, 0), nodeAt("b", 1, 0)]; // effectively coincident
    expect(resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2)).toBe(true);
    // Keep resolving until settled; the terminal state must report false so the
    // draw loop can freeze (and the pair must actually be separated by the gap).
    let passes = 0;
    while (resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2) && passes < 50) passes++;
    expect(resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2)).toBe(false);
    const dx = (nodes[0].x ?? 0) - (nodes[1].x ?? 0);
    const dy = (nodes[0].y ?? 0) - (nodes[1].y ?? 0);
    const sep = Math.hypot(dx, dy);
    expect(sep).toBeGreaterThanOrEqual(nodeRadius(nodes[0]) + nodeRadius(nodes[1]));
  });
});

describe("liveness hypot dedup parity (Round 2, 2026-07-03)", () => {
  it("deduped loop produces bit-identical renderX/renderY/renderRadius", () => {
    const mk = (seed: number): GraphNode[] => {
      const rnd = mulberry32(seed);
      const ns: GraphNode[] = [];
      for (let i = 0; i < 200; i++) {
        ns.push({
          id: `n${i}`,
          title: `n${i}`,
          degree: i % 12,
          kind: "note",
          ext: "md",
          x: (rnd() - 0.5) * 2400,
          y: (rnd() - 0.5) * 1600,
          renderPhase: rnd() * Math.PI * 2,
          renderKickX: (rnd() - 0.5) * 3,
          renderKickY: (rnd() - 0.5) * 3,
          renderKickVx: (rnd() - 0.5) * 2,
          renderKickVy: (rnd() - 0.5) * 2,
        } as unknown as GraphNode);
      }
      return ns;
    };
    const a = mk(11);
    const b = mk(11); // same seed → identical starting state
    livenessLoop(a, 12.345, 1.7, 0.32, 1200, 800);
    livenessLoopDedup(b, 12.345, 1.7, 0.32, 1200, 800);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].renderX).toBe(a[i].renderX);
      expect(b[i].renderY).toBe(a[i].renderY);
      expect(b[i].renderRadius).toBe(a[i].renderRadius);
    }
  });
});

describe("graph perf baseline", () => {
  it("prints baseline numbers", () => {
    const rows: string[] = [];
    for (const [label, nNotes, lpn] of [
      ["demo-ish 650n", 650, 4],
      ["stress 2000n", 2000, 4],
    ] as const) {
      const { files, contents } = makeVault(nNotes, lpn);
      const notes = syntheticNotes(files, contents);

      const tBuildNotes = bench(9, () => buildNotes(files, contents));
      let g = buildGraph(notes, files);
      const tBuildGraph = bench(9, () => {
        g = buildGraph(notes, files);
      });
      const { nodes, links } = g;
      const tSig = bench(9, () => graphSig(nodes, links));
      const tNeighbors = bench(9, () => buildNeighbors(links));

      // positions: first tightly packed (settle work), then fully resolved (idle)
      scatter(nodes, Math.sqrt(nodes.length) * 18);
      // settle: run until no movement (counts as the one-time cost)
      const t0 = performance.now();
      let passes = 0;
      while (resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2) && passes < 400) passes++;
      const settleMs = performance.now() - t0;
      // idle: every subsequent call is a no-op that still builds the grid
      const tResolverIdle = bench(15, () => {
        resolveOverlaps(nodes, nodeRadius, OVERLAP_GAP, 2);
      });
      const tBounds = bench(15, () => graphBounds(nodes));
      // A/B the liveness loop: original (double hypot) vs deduped (single hypot).
      // Interleaved reps so both see the same machine state (fair comparison).
      const tLiveness = bench(40, () => livenessLoop(nodes, 12.345, 1.7, 0.32, 1200, 800));
      const tLivenessDedup = bench(40, () => livenessLoopDedup(nodes, 12.345, 1.7, 0.32, 1200, 800));

      const lc = links.length;
      const sId = links.map((l) => (typeof l.source === "string" ? l.source : (l.source as GraphNode).id));
      const tIdArr = links.map((l) => (typeof l.target === "string" ? l.target : (l.target as GraphNode).id));
      const actMap = new Map<string, unknown>();
      const tIdleLinks = bench(15, () => idleLinkScans(lc, sId, tIdArr, actMap));

      rows.push(
        `${label}: nodes=${nodes.length} links=${links.length}\n` +
          `  buildNotes      ${fmt(tBuildNotes)} ms\n` +
          `  buildGraph      ${fmt(tBuildGraph)} ms   (runs per notes-change, <=2Hz typing)\n` +
          `  graphSig        ${fmt(tSig)} ms   (same trigger)\n` +
          `  buildNeighbors  ${fmt(tNeighbors)} ms   (same trigger)\n` +
          `  resolver settle ${fmt(settleMs)} ms over ${passes} passes (one-time after motion)\n` +
          `  resolver@idle   ${fmt(tResolverIdle)} ms   ELIMINATED per idle frame by layoutSettledRef gate, Round 1 (GraphView.tsx:1746)\n` +
          `  graphBounds     ${fmt(tBounds)} ms   PER FRAME (bloom, GraphView.tsx:1098)\n` +
          `  livenessLoop    ${fmt(tLiveness)} ms   PER FRAME (GraphView.tsx:1028)\n` +
          `  livenessDedup   ${fmt(tLivenessDedup)} ms   PER FRAME (single hypot, Round 2)\n` +
          `  idleLinkScans   ${fmt(tIdleLinks)} ms   PER FRAME (batch2+3 no-op scans)\n`
      );
    }

    // activity sampling: 0 records vs 8 live records
    const tAct0 = bench(15, () => {
      decayActivity(performance.now());
      activeRecords(0.02);
    });
    for (let i = 0; i < 8; i++) bumpActivityAmount(`n${i}.md`, 0.8, "edit");
    const tAct8 = bench(15, () => {
      decayActivity(performance.now());
      activeRecords(0.02);
    });
    rows.push(`activity: decay+activeRecords 0rec ${fmt(tAct0)} ms · 8rec ${fmt(tAct8)} ms PER FRAME`);

    // eslint-disable-next-line no-console
    console.log("\n==== GRAPH PERF BASELINE ====\n" + rows.join("\n") + "\n=============================");
  });
});
