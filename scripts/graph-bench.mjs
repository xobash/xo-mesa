// Seeded synthetic-vault graph benchmark. Measures the graph's JavaScript work
// in Node: data build, force ticks, hit-testing, label placement and retained
// heap. It does not measure WebKit/WebView2 canvas rasterization or native frames.
import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sizes = (process.argv[2] ?? '1000,5000,10000,20000').split(',').map(Number).filter(n => n > 0);
const directory = mkdtempSync(join(tmpdir(), 'mesa-graph-bench-'));
try {
  const modulePath = join(directory, 'graph.mjs');
  const entry = join(directory, 'entry.ts');
  writeFileSync(entry, [
    `export { buildGraph } from ${JSON.stringify(resolve('src/lib/graph.ts'))};`,
    `export { createGraphSimulation, graphSimulationTier, GraphPhysicsSession, snapshotGraphPhysics, GRAPH_SETTLED_ALPHA } from ${JSON.stringify(resolve('src/lib/graphPhysics.ts'))};`,
    `export { nodeRadius, resolveOverlaps, GraphHitIndex, nearestNodeLinear } from ${JSON.stringify(resolve('src/components/graphGeometry.ts'))};`,
    `export { buildNeighbors } from ${JSON.stringify(resolve('src/lib/graph.ts'))};`,
  ].join('\n'));
  buildSync({ entryPoints: [entry], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const runner = join(directory, 'measure.mjs');
  writeFileSync(runner, `
import * as g from ${JSON.stringify(pathToFileURL(modulePath).href)};
const size = Number(process.argv[2]);

// mulberry32: deterministic vault for a given size.
let seed = 0x5eed ^ size;
const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (n) => Math.floor(random() * n);
const words = 'kelp tide current reef survey heat canopy urchin otter nitrate mooring sample transect thesis model data review plan field lab'.split(' ');
const title = (i) => words[i % words.length] + ' ' + words[(i * 7) % words.length] + ' ' + i;

// About 8% attachments, 20% orphan notes, clustered notes with power-law hubs.
const files = [], notes = {};
const noteCount = Math.round(size * 0.92);
const clusterSize = 60;
const linkedTargets = [];
for (let i = 0; i < noteCount; i++) {
  const folder = 'Area ' + Math.floor(i / 400);
  const rel = folder + '/' + title(i) + '.md';
  files.push({ path: '/vault/' + rel, relPath: rel, name: title(i), ext: 'md', isMarkdown: true, mtime: 1e12 + i * 1000, createdAt: 1e12 + i * 1000, size: 2000 });
}
const attachments = size - noteCount;
for (let i = 0; i < attachments; i++) {
  const rel = 'Assets/image ' + i + '.png';
  files.push({ path: '/vault/' + rel, relPath: rel, name: 'image ' + i, ext: 'png', isMarkdown: false, size: 40000 });
}
for (let i = 0; i < noteCount; i++) {
  const rel = files[i].relPath;
  const rawLinks = [];
  if (random() >= 0.2) {
    const cluster = Math.floor(i / clusterSize) * clusterSize;
    const count = 1 + Math.floor(-Math.log(1 - random()) * 3);
    for (let k = 0; k < count; k++) {
      let target;
      const r = random();
      if (r < 0.55) target = cluster + pick(clusterSize);
      else if (r < 0.8 && linkedTargets.length) target = linkedTargets[pick(linkedTargets.length)];
      else target = pick(noteCount);
      if (target < noteCount && target !== i) { rawLinks.push(files[target].name); linkedTargets.push(target); }
    }
    if (attachments && random() < 0.05) rawLinks.push('image ' + pick(attachments) + '.png');
  }
  notes[rel] = { relPath: rel, title: files[i].name, rawLinks, tags: [], aliases: [] };
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  return { p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), max: +(sorted[sorted.length - 1] ?? 0).toFixed(3) };
};
const time = (fn) => { const t = performance.now(); const value = fn(); return [performance.now() - t, value]; };
const opts = { showTags: false, existingOnly: false, showOrphans: true, showAttachments: true };

global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const [buildMs, built] = time(() => g.buildGraph(notes, files, opts));
const { nodes, links } = built;
const view = { w: 1400, h: 900 };
const radius = (n) => g.nodeRadius(n, 1);
const tier = g.graphSimulationTier(nodes.length);
const [createMs, sim] = time(() => g.createGraphSimulation(nodes, links, { ...view, radius, repel: 10, center: 0.5, linkForce: 1, linkDistance: 250 }));
const [warmMs] = time(() => { for (let i = 0; i < tier.warmTicks; i++) sim.tick(); });
sim.alpha(tier.openAlpha);
const workerNodes = nodes.map(() => ({ x: 0, y: 0, vx: 0, vy: 0 }));

// Settling after first paint, from the same warmed layout two ways.
// Main thread (below 2,000 nodes): one GraphView frame of ticks, then idle
// overlap passes until nothing moves. Worker (2,000+ nodes): the main thread
// only snapshots once and copies each posted state.
const phase = (n) => { let h = 2166136261; for (let i = 0; i < n.id.length; i++) { h ^= n.id.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) / 0xffffffff) * Math.PI * 2; };
const [snapshotMs, init] = time(() => g.snapshotGraphPhysics(sim, { collideIterations: tier.collideIterations, velocityCap: 6, doubleTickBelow: 650, grab: null, overlap: { gap: 8, radius, phase } }));
const settleFrames = [], overlapFrames = [];
let settleTicks = 0;
for (let settled = false, frames = 0; !settled && frames < 3000; frames++) {
  let ms = 0;
  if (sim.alpha() > g.GRAPH_SETTLED_ALPHA) {
    const ticks = nodes.length < 650 && sim.alpha() > 0.06 ? 2 : 1;
    ms += time(() => { for (let t = 0; t < ticks; t++) sim.tick(); })[0];
    settleTicks += ticks;
  }
  if (sim.alpha() <= 0.02) {
    const [overlapMs, moved] = time(() => g.resolveOverlaps(nodes, radius, 8, 2));
    ms += overlapMs; overlapFrames.push(overlapMs);
    settled = !moved && sim.alpha() <= g.GRAPH_SETTLED_ALPHA;
  }
  settleFrames.push(ms);
}
const session = new g.GraphPhysicsSession(init);
const workerSteps = [], copyFrames = [];
while (!session.settled && workerSteps.length < 3000) {
  workerSteps.push(time(() => session.step())[0]);
  const state = session.state();
  copyFrames.push(time(() => { for (let k = 0; k < nodes.length; k++) { const n = workerNodes[k]; n.x = state[k * 4]; n.y = state[k * 4 + 1]; n.vx = state[k * 4 + 2]; n.vy = state[k * 4 + 3]; } })[0]);
}
let maxDrift = 0;
for (let k = 0; k < nodes.length; k++) maxDrift = Math.max(maxDrift, Math.abs(workerNodes[k].x - nodes[k].x), Math.abs(workerNodes[k].y - nodes[k].y));

// Hover hit-testing at fit zoom: 2,000 seeded pointer positions.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
const k = Math.min((view.w - 48) / Math.max(1, maxX - minX), (view.h - 48) / Math.max(1, maxY - minY));
const queries = Array.from({ length: 2000 }, (_, i) => i % 2 ? nodes[pick(nodes.length)] : { x: minX + random() * (maxX - minX), y: minY + random() * (maxY - minY) });
const linear = [], indexed = [];
let mismatches = 0;
const [indexBuildMs, index] = time(() => new g.GraphHitIndex(nodes, radius));
for (const q of queries) {
  const qx = q.x + (random() - 0.5) * 4, qy = q.y + (random() - 0.5) * 4;
  const [a, hitA] = time(() => g.nearestNodeLinear(nodes, qx, qy, k, radius));
  const [b, hitB] = time(() => index.nearest(qx, qy, k));
  linear.push(a); indexed.push(b);
  if (hitA !== hitB) mismatches++;
}

// Label placement as GraphView does it while the top hub is hovered: the
// hub, its first 24 neighbours, then the 10 highest-degree nodes, each checked
// against every placed box. measureText is approximated; WebKit text cost is not measured.
const byDegree = [...nodes].sort((a, b) => b.degree - a.degree);
const byId = new Map(nodes.map((n) => [n.id, n]));
const neighbours = g.buildNeighbors(links).get(byDegree[0]?.id) ?? new Set();
const labelZoom = 0.9;
const t = { k: labelZoom, x: view.w / 2 - ((minX + maxX) / 2) * labelZoom, y: view.h / 2 - ((minY + maxY) / 2) * labelZoom };
const labelFrames = [];
let placed = 0;
for (let i = 0; i < 60; i++) {
  const [ms, count] = time(() => {
    const taken = [], done = new Set();
    const place = (n, forced) => {
      if (taken.length >= 120 || done.has(n.id)) return;
      const sx = n.x * t.k + t.x, sy = n.y * t.k + t.y;
      if (sx < -60 || sy < -20 || sx > view.w + 60 || sy > view.h + 20) return;
      const tw = n.title.length * 6.6, ly = sy + radius(n) * t.k + 9;
      const box = { x0: sx - tw / 2 - 3, y0: ly - 8, x1: sx + tw / 2 + 3, y1: ly + 8 };
      if (!forced) for (const o of taken) if (box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0) return;
      taken.push(box); done.add(n.id);
    };
    if (byDegree[0]) place(byDegree[0], true);
    let labelled = 0;
    for (const id of neighbours) { if (labelled++ >= 24) break; const n = byId.get(id); if (n) place(n, false); }
    for (let j = 0; j < Math.min(10, byDegree.length); j++) place(byDegree[j], false);
    return taken.length;
  });
  labelFrames.push(ms); placed = count;
}

sim.stop();
global.gc();
const heapAfter = process.memoryUsage().heapUsed;
console.log(JSON.stringify({
  size, nodes: nodes.length, links: links.length, orphans: nodes.filter(n => n.degree === 0).length,
  buildMs: +buildMs.toFixed(1), createMs: +createMs.toFixed(1), warmTicks: tier.warmTicks, warmMs: +warmMs.toFixed(1),
  settleTicks, mainSettleFrames: settleFrames.length, mainSettleFrameMs: stats(settleFrames), mainLongFrames: settleFrames.filter(ms => ms > 50).length,
  idleOverlapFrames: overlapFrames.length, idleOverlapFrameMs: stats(overlapFrames),
  workerSnapshotMs: +snapshotMs.toFixed(2), workerSteps: workerSteps.length, workerStepMs: stats(workerSteps), workerCopyFrameMs: stats(copyFrames), workerMaxDrift: +maxDrift.toExponential(2),
  hitIndexBuildMs: +indexBuildMs.toFixed(2), hitLinearMs: stats(linear), hitIndexedMs: stats(indexed), hitMismatches: mismatches,
  labelFrameMs: stats(labelFrames), labelsPlaced: placed,
  retainedHeapMB: +((heapAfter - heapBefore) / 1048576).toFixed(1),
}));
`);
  // Repeated open/close in one process: retained heap after each cycle.
  const cycles = join(directory, 'cycles.mjs');
  writeFileSync(cycles, `
import * as g from ${JSON.stringify(pathToFileURL(modulePath).href)};
const size = Number(process.argv[2]);
const files = [], notes = {};
for (let i = 0; i < size; i++) {
  const rel = 'n' + i + '.md';
  files.push({ path: '/v/' + rel, relPath: rel, name: 'n' + i, ext: 'md', isMarkdown: true });
  notes[rel] = { relPath: rel, title: 'n' + i, rawLinks: i % 5 ? ['n' + ((i * 31) % size)] : [], tags: [], aliases: [] };
}
const heap = [];
for (let cycle = 0; cycle < 6; cycle++) {
  const { nodes, links } = g.buildGraph(notes, files, { showTags: false, existingOnly: false, showOrphans: true, showAttachments: true });
  const radius = (n) => g.nodeRadius(n, 1);
  const sim = g.createGraphSimulation(nodes, links, { w: 1400, h: 900, radius, repel: 10, center: 0.5, linkForce: 1, linkDistance: 250 });
  for (let i = 0; i < 5; i++) sim.tick();
  new g.GraphHitIndex(nodes, radius).nearest(0, 0, 1);
  sim.stop();
  global.gc();
  heap.push(+(process.memoryUsage().heapUsed / 1048576).toFixed(1));
}
console.log(JSON.stringify({ size, heapMBPerCycle: heap, growthMB: +(heap[heap.length - 1] - heap[1]).toFixed(1) }));
`);
  for (const size of sizes) {
    const child = spawnSync(process.execPath, ['--expose-gc', runner, String(size)], { encoding: 'utf8', maxBuffer: 1 << 24 });
    if (child.status !== 0) throw new Error(child.stderr || 'Graph benchmark failed');
    process.stdout.write(child.stdout);
  }
  const child = spawnSync(process.execPath, ['--expose-gc', cycles, String(Math.min(10000, Math.max(...sizes)))], { encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr || 'Graph cycle benchmark failed');
  process.stdout.write(child.stdout);
} finally { rmSync(directory, { recursive: true, force: true }); }
