# Graph view + preview/editor latency optimizations (2026-07-01)

Rollback: pre-change copies of every touched graph/preview file are in
`.backups/graph-view-2026-07-01/`. Copy any file back over `src/` to revert.

---

# Graph render-cost pass — evidence-driven idle/frame optimization (2026-07-03)

Goal: make the graph cheaper at idle/per-frame with **zero** behavior/visual/feel
change. Method: measure first (`src/lib/graph.perf.test.ts` — reproducible bench
of the pure hot paths + private-helper equivalents with source line citations),
change only what the numbers justify, re-measure. Bench numbers below are medians
from that file (V8/vitest on the dev machine; absolute values are machine- and
load-dependent, so trust the deltas, not the absolutes).

Baseline per-frame costs measured (2000n / ~8000 links, the stress case):
`resolver@idle` 3.9–4.5 ms · `livenessLoop` 0.28 ms · `graphBounds` 0.005 ms ·
`idleLinkScans` 0.09 ms · activity decay+scan ~0.002 ms. The resolver dwarfed
everything: it was ~90%+ of non-draw per-frame compute and ran **every idle
frame**. `getComputedStyle` was already off the frame path (cached behind
`themeDirtyRef`); per-frame React writes were already zero (`activitySigRef`
guard). Note: the "green baseline" was actually red — the prior session's bench
had an unused import that broke `tsc`; fixed here.

## Round 1 — gate the idle overlap resolver behind a settled-layout flag

- **Evidence.** `resolveOverlaps()` (GraphView.tsx:113) ran every frame at idle
  (`!settling` branch, GraphView.tsx:1744), allocating a fresh hash-grid `Map`
  and doing two O(n) passes just to confirm nothing moved: **1.0 ms @650n,
  3.9–4.5 ms @2000n, every idle frame** (60 fps ⇒ 60–270 ms/s of pure waste).
- **Why it's redundant.** The resolver reads/writes only layout `x/y`. Ambient
  living motion writes `renderX/renderY/renderRadius` and never touches `x/y`
  (GraphView.tsx liveness loop, verified). The only force-node `x/y` writers are
  `sim.tick()` (gated on `alpha>0.004`) and the resolver itself. So once the
  resolver reports `moved=false` and the sim stops ticking, re-running it is a
  provable no-op until the sim ticks or the graph rebuilds.
- **Change.** `layoutSettledRef` (GraphView.tsx): freeze when the resolver
  returns `moved=false`; skip the resolver while frozen; clear the flag in the
  sim-tick block (the single choke point every `x/y` movement passes through, so
  any real motion re-arms it). Content-only rebuilds set `alpha(0)` and copy
  positions verbatim, so the flag correctly persists across them.
- **Numbers.** resolver@idle **3.9–4.5 ms → ~0 ms** per idle frame at 2000n
  (one boolean check) once settled; **1.0 ms → ~0** at 650n. Settling and the
  final no-overlap resolution are unchanged (it still runs every frame with
  energy). Bonus: render-only impulses (`kickGraph`, the `motionUntil` window)
  no longer trigger the resolver either, since they don't tick the sim.
- **Parity.** No-overlap-at-rest guarantee intact: the resolver still runs after
  every position change and freezes only after confirming `moved=false`. The
  "resolver only at idle, never during drag/settle" rule is unchanged.
- **Safety pinned by test.** `graph.perf.test.ts` → "idle-resolver gate safety
  basis": `resolveOverlaps` returns `false` on a non-overlapping layout
  (idempotent) and `true` when nodes overlap, resolving to a stable separated
  `false`. That boolean contract is the whole basis for freezing.
- 🟡 **Desktop QA:** idle CPU/battery should drop on large vaults; graph must
  look/behave identically — no overlaps creep in at rest, drag still separates
  nodes, twinkle/bloom unchanged.

## Round 2 — de-duplicate the per-node distance in the liveness loop

- **Evidence.** The render-liveness loop (GraphView.tsx:1028, runs for **all**
  nodes every living frame) computed `Math.hypot(cx, cy)` **twice** with
  identical args — once for the `radial` breathe scale, once for the inward unit
  vector `invLen`.
- **Change.** Compute it once into `len`, reuse for both. Same function, called
  once; output is bit-identical.
- **Numbers (controlled A/B, interleaved in one bench run, stable across 3
  runs).** liveness loop **0.278 → 0.223 ms @2000n (~20%)**, **0.094 → 0.075 ms
  @650n (~20%)**. Above the ~±0.05 ms noise band because both variants are timed
  under the same machine state and the ratio held at ~0.80 every run.
- **Parity pinned by test.** `graph.perf.test.ts` → "liveness hypot dedup
  parity": deduped loop yields byte-identical `renderX/renderY/renderRadius`.

## Measured, rejected (kept as-is, with numbers)

- **`buildGraph` (6–11 ms @2000n).** Runs on notes-metadata change, which is
  **500 ms-debounced** (`setContentFromEditor`, store.ts) — never per keystroke.
  Already gated; not a frame cost.
- **`graphBounds` (bloom, ~0.005 ms), `idleLinkScans` batch2/3 (~0.09 ms),
  activity decay+scan (~0.002 ms).** Below noise; not worth touching.
- **Per-frame endpoint `sId/tId` rewrite (GraphView.tsx:1143).** Static between
  rebuilds, but hoisting them into the rebuild effect is sub-noise (<0.05 ms) and
  adds a real correctness hazard (ids must repopulate after d3 resolves string→
  object endpoints in two rebuild branches). Not worth it.
- **Per-node `fillStyle`/liveness for offscreen nodes.** `fillStyle` varies per
  node (distinct colors) — inherently unbatchable. Skipping liveness for culled
  nodes would leave stale `renderX/renderY` for offscreen endpoints of visible
  links → visible glitch on pan. Rejected: 0.28 ms isn't worth a feel risk.
- **`getComputedStyle` / per-frame React writes.** Already off the frame path.

Checks: `npm run typecheck` (0 errors) · `npm test` (355 passed) ·
`npm run build` (ok). Bench: `npx vitest run src/lib/graph.perf.test.ts`.

## Graph view (`GraphView.tsx`, `lib/graph.ts`)

- **Hover focus (Obsidian-style highlight).** Hovering a node now highlights
  its neighborhood: non-neighbor nodes, links, and labels dim (~68%), incident
  links brighten and thicken, and neighbor labels fade in (overlap-avoided,
  capped at 24). The transition eases over ~150ms in both directions
  (`focusRef` smoothstep in the draw loop) so it glides instead of flashing.
  Costs nothing per-link: dimmed links reuse the existing batch-1 stroke with
  one `globalAlpha`. Focus releases automatically during drag.
- **Neighbor sets** come from `buildNeighbors(links)` in `lib/graph.ts`
  (unit-tested; handles string and post-simulation object endpoints).
- **Double-click empty canvas → fit view** (matches the toolbar Fit button).
- **Hover prewarm.** The moment the pointer lands on a node, its preview
  content peek starts loading, so the card body is ready when the hover delay
  elapses.

## Preview cards (`PreviewCard.tsx`, `previewTriggers.ts`, `store.ts`, `lib/vault.ts`)

- **Byte-capped peek reads.** Previews render at most a few KB, but previously
  read whole files through IPC. New `peekNote()` reads ≤16KB from the file
  head (`decodePeekBytes` strips any cut multi-byte UTF-8 char; unit-tested).
  `store.ensurePeek()` fronts it with a 32-entry / 10s cache, deduped
  concurrent reads, and full-cache priority. Peeks are kept strictly out of
  `contentCache` so truncated text can never reach the editor or disk.
- **Safety: preview HTML iframes are now fully sandboxed** (`sandbox=""` — no
  scripts, popups, forms, or same-origin access from a hover peek).

## Editor + open path (`Editor.tsx`, `store.ts`)

- **Opening a file is instant.** `selectFile` switches the active file
  immediately (cache-hit synchronous) and streams content in when the read
  lands, instead of blocking the switch on the disk read.
- **Per-keystroke cost removed.** The editor no longer re-serializes the whole
  document on every store echo (`lastEditorTextRef` identity check) — typing
  in large notes previously did an extra O(doc) `toString()` per keystroke.
- **Stale-read guard.** `ensureContent` never overwrites cache entries written
  while its disk read was in flight (typing during load can't be clobbered);
  `selectFile` re-checks the active path and cache before committing content.
