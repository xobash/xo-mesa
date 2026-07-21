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

## Round 3 — memoize link resolution inside `buildGraph` (2026-07-06)

- **Evidence.** `buildGraph` cost **7.78 ms @2000n/7978L** (2.46 ms @650n) per
  notes change — 500 ms-debounced, so ≤2 Hz while typing, but it runs
  synchronously in GraphView's build effect next to `graphSig` (1.83 ms) and
  `buildNeighbors` (1.10 ms): an ~11 ms main-thread burst at stress scale.
  Line-level: `resolve(raw)` ran **twice per rawLink** — pass 1 (graph.ts, the
  note→note edge pass) and pass 2 re-resolved the *same* raw to decide
  attachment/phantom fallback — and hub targets repeat across many notes, each
  repeat redoing trim → backslash replace → toLowerCase → `.md` strip → split.
- **Change.** Per-invocation `Map<string, string|null>` memo (`resolveCached`
  in `buildGraph`): each unique raw normalized once, every other call a Map
  hit. Scoped inside one `buildGraph` call — no cross-invocation staleness
  possible; output identical by construction.
- **Numbers (stable across 3 runs).** buildGraph **7.78 → 4.67 ms @2000n
  (−40%)**; 2.46 → 2.34 ms @650n (−4%; resolution is a smaller share at small
  scale). Parity: all 17 `graph.test.ts` tests (title/relpath/alias resolution,
  attachments, phantoms, tags, orphans) pass unchanged.

## Round 4 — backlinksFor served from a cached inverted index (2026-07-17)

- **Evidence.** `backlinksFor` (graph.ts) rebuilt the full title/alias resolver
  and re-resolved every rawLink of every note **per call**: 2.05 ms @2000n
  (0.73 ms @650n, `graph.perf.test.ts` → "backlinks old"). It runs from the
  always-mounted StatusBar (memoized on `[notes, activePath]` → once per notes
  change AND once per file switch) and from the Backlinks panel (per render,
  same triggers) — the same full-vault scan duplicated per consumer and repeated
  on every file switch.
- **Change.** `backlinkIndex` (graph.ts): one pass builds the whole
  target→sorted-sources map with the Round-3 per-unique-raw resolve memo,
  cached in a `WeakMap` keyed on the notes object identity. Safe because the
  store replaces `notes` immutably on every mutation (all writes are spread
  copies — verified store.ts), so identical identity ⇔ identical topology;
  the WeakMap frees the index when notes is replaced. `backlinksFor` keeps its
  signature and returns the cached array (documented read-only; both consumers
  only read).
- **Numbers (graph.perf.test.ts).** Old **2.05 ms per call per consumer**
  @2000n → index rebuild **2.42 ms once per notes change** + **~0.000 ms per
  lookup**. Statusbar-only case pays +0.4 ms per ≤2 Hz notes change; in return
  every file switch (2.05 → ~0) and every additional consumer (Backlinks
  panel: 2.05 → ~0) is free.
- **Parity pinned by test.** `graph.test.ts` → "cached index parity" (verbatim
  pre-index implementation compared on every note of a vault with aliases,
  case-insensitive and path links, self-links, misses), "excludes a note's
  link to itself", and "index is keyed by notes identity" (fresh object →
  fresh answers; old object's cache untouched).

## Round 5 — sidebar tree decoupled from notes churn (2026-07-17)

- **Evidence.** `FileTree` subscribed to `s.notes`, whose identity is replaced
  by every debounced editor save (≤2 Hz while typing, `setContentFromEditor`).
  Each churn re-ran `annotateAggregates`, rebuilt the comparator, and
  re-rendered + re-sorted every `TreeItem` in the sidebar — for a rendered
  output that cannot change: note metadata reaches the tree **only** through
  the "links" sort mode (rawLinks counts feed `fileComparator`/folder
  aggregates — verified sort.ts); names/exts/bookmarks/active state all come
  from `files`/settings.
- **Change.** FileTree's `notes` subscription now returns a stable
  `EMPTY_NOTES` object unless `settings.sortMode === "links"` (where live
  re-sorting is the feature and behavior is unchanged). The two event handlers
  that need real titles (rename commit, delete confirm) read
  `getStore().notes` at event time — fresher than the old subscribed snapshot.
- **Effect.** While typing in any non-links sort mode the sidebar does zero
  work (no selector-value change → no render). Rendered output is identical
  by construction; no React-render bench exists in this repo (no component
  runner), so this is claimed as eliminated-work, not a ms number.

## Round 6 — no-op saves stop replacing `notes` (2026-07-17)

- **Evidence.** The debounced editor save (`setContentFromEditor`, store.ts)
  replaced the `notes` object identity on EVERY fire, even when the extracted
  metadata (rawLinks/tags/aliases) was byte-identical — the common case while
  typing prose. That identity churn is the trigger for the entire ≤2 Hz
  cascade this doc measures: GraphView's build effect (buildGraph 4.7 ms +
  graphSig 1.8 ms + buildNeighbors 1.1 ms @2000n, plus node reconciliation and
  endpoint-array rebuilds), the Round-4 backlink index rebuild (2.4 ms), the
  FileTree links-mode re-sort, TagList's tag rescan, StatusBar, Backlinks.
- **Change.** New pure `refreshedNoteMeta(cur, src)` (graph.ts): re-extracts
  the three arrays and returns `null` when all compare equal (element-wise;
  extraction is deterministic, so same-text ⇒ same-order). The debounced save
  only spreads + `set`s `notes` on a non-null result. Disk write behavior is
  untouched — the note text still saves every debounce; only the metadata
  broadcast is skipped. `firstImagePath` is deliberately not refreshed
  (the old path never did; documented in the helper).
- **Effect.** Typing prose without touching links/tags/aliases now costs the
  extraction compare only (~O(text) extract, sub-ms — the same extracts the
  old code already ran) instead of the ~10 ms downstream cascade @2000n.
  Editing links/tags/aliases behaves exactly as before.
- **Behavior note.** One incidental delta: GraphView's equal-topology rebuild
  used to zero surviving nodes' velocities on every save; a skipped no-op save
  no longer interrupts in-flight motion (the sim keeps its natural state —
  strictly less intervention, and the settle path is unchanged).
- **Parity pinned by test.** `graph.test.ts` → "refreshedNoteMeta": null on
  prose-only/identical edits, refresh on link/tag/alias add-remove with all
  other fields carried over.

## Measured, rejected (kept as-is, with numbers)

- **`buildGraph` beyond the Round-3 memo.** Runs on notes-metadata change,
  which is **500 ms-debounced** (`setContentFromEditor`, store.ts) — never per
  keystroke. After the memo the remaining cost is the honest work (edge
  building, node assembly); no waste left worth the churn.
- **`graphSig` (1.83 ms @2000n, same ≤2 Hz trigger).** An order-independent
  hash would drop the two O(m log m) sort+joins but adds a collision risk that
  could silently skip a topology settle (behavior hazard) — rejected: 1.8 ms
  every ≥500 ms is ~0.4% CPU while typing, not worth a correctness edge case.
- **`buildNotes` (4.4 ms @2000n).** Called at vault open only
  (store.ts `openVault`); watcher/editor updates patch individual note metas.
  Not an interactive cost.
- **Label-pass `measureText` caching.** ~10–34 `measureText` calls per ambient
  frame at label zoom, all on unchanged title strings (constant font). Real but
  micro (≲0.1 ms warm, unmeasurable in vitest — no canvas); the pass's actual
  cost is the strokeText/fillText that IS the feature. Rejected at this scale;
  first candidate if a device profile ever shows the label pass hot.
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
