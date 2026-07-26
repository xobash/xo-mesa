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

---

# Adaptive efficiency campaign (2026-07-23)

Goal: improve startup payload, idle memory/subscriptions, repository footprint,
and verification time while preserving every UI, API, file format, dependency,
and safety boundary. The starting worktree already contained an in-progress
Markdown renderer split; its **current** entry chunk was used as the baseline,
so this campaign does not claim prior work.

## Baseline

- Frontend: typecheck clean; 53 Vitest files / 493 tests passed; production
  build 447 modules in 2.70 s.
- Startup entry: **483.41 kB minified / 157.64 kB gzip**.
- Full test wall time: **7.55 s**; the timing-only graph baseline consumed
  6.15 s of the test body.
- Dist: 3.8 MB; installed npm tree: 343 MB / 270 lockfile packages
  (69 production, 200 development plus root).
- Native: 19 Rust tests passed; no-feature dev build warning-free.
- Repository: 4.2 MB tracked; `docs/mesa-overlay.png` was 631,070 bytes.

## Round 1 — defer GraphView and d3-force

- **Selection.** Graph is absent from the default Editor + Preview workspace,
  yet every main/popout startup parsed its canvas renderer and force engine.
- **Change.** `App.tsx` lazy-loads `GraphView.tsx` behind a layout-stable
  `.graph-wrap` Suspense fallback. `graphLoadContract.test.ts` pins the dynamic
  boundary and GraphView's exclusive production ownership of `d3-force`.
- **Measured.** Entry **483.41 → 439.76 kB minified** and
  **157.64 → 141.02 kB gzip** (−9.0% / −10.5%). Graph is a local on-demand
  42.58 kB / 16.19 kB gzip chunk.
- **Compatibility.** Existing graph logic/tests are unchanged; the targeted
  graph suite, boundary tests, typecheck, and production build passed.

## Round 2 — defer closed Pi and Steam-overlay trees

- **Selection.** Closed Pi and Steam overlay surfaces pulled in AgentPanel,
  browser harness, Deep Research UI, and the full overlay window implementation
  at every startup.
- **Change.** Pi surfaces load only when a workspace/window route or the
  existing `agentOpen`/`piOverlayOpen` flags request them. The Steam overlay
  loads on first open and remains mounted thereafter, preserving its existing
  240 ms close-animation lifecycle.
- **Measured.** Entry **439.76 → 371.89 kB minified** and
  **141.02 → 120.78 kB gzip** (−15.4% / −14.4% for this round). Deferred
  chunks: AgentPanel 43.68 kB / 14.22 kB gzip; Overlay 25.55 kB / 8.38 kB gzip.
- **Compatibility.** `optionalSurfaceLoadContract.test.ts` pins both flag gates
  and the retain-after-first-open behavior. Pi/window/layout contract tests,
  typecheck, and production build passed.

## Round 3 — defer closed ephemeral modals

- **Selection.** Command palette, search, and settings had no closed-state
  responsibilities but still added startup code and store subscriptions.
- **Change.** One App boundary loads each modal only under its existing open
  flag; component state, focus effects, commands, and styling are unchanged.
- **Measured.** Entry **371.89 → 363.23 kB minified** and
  **120.78 → 118.37 kB gzip**. The marginal win was small enough to stop
  further modal splitting.
- **Compatibility.** The optional-surface contract test pins all three imports
  and flags; keyboard, layout, typecheck, and build checks passed.

## Round 4 — losslessly recompress the overlay screenshot

- **Selection.** A tracked 631 kB documentation PNG had a measurable lossless
  recompression opportunity; runtime assets and app icons were left untouched.
- **Change.** Recompressed `docs/mesa-overlay.png` at the same 2880×1800 RGBA
  dimensions while retaining DPI, EXIF, and ICC metadata.
- **Measured.** **631,070 → 332,381 bytes**: −298,689 bytes (−47.3%).
  Pillow's decoded-pixel difference bounding box was `None` (pixel-identical).

## Round 5 — keep the timing benchmark out of normal tests

- **Selection.** The graph timing baseline only prints machine-dependent
  numbers; its real regression/parity assertions are separate tests, but the
  timing loop consumed most of every full suite.
- **Change.** The timing-only case runs under Vite mode `graph-bench` through
  `npm run test:perf`. The three resolver/liveness parity tests remain in every
  `npm test`.
- **Measured.** Full-suite wall time **7.55 → 4.89 s** (−35.2%) while adding
  eight passing boundary assertions; the normal pass count rose by seven
  because the timing-only case is now skipped. The opt-in benchmark still runs
  all four graph tests and prints the full 650/2000-node table.

## Campaign result and stop decision

- Startup entry: **483.41 → 363.23 kB minified** (−120.18 kB, −24.9%) and
  **157.64 → 118.37 kB gzip** (−39.27 kB, −24.9%).
- Repository disk: −298,689 bytes with no decoded-pixel change.
- Test feedback: −35.2% wall time; all compatibility assertions preserved.
- Dependencies and native feature flags were unchanged. Every direct npm/Rust
  dependency has a live source use; removing or consolidating one would be a
  high-risk product/runtime change.
- Kept as-is after reassessment: SyncModal (owns live discovery side effects
  even while closed), the full-vault content cache (required by instant
  search/tasks/research context), PDF engines/worker (feature-critical), Graph
  image caches (no measured memory profile proving a safe cap), and native
  TLS/PTY dependencies. The PDF thumbnail cache was measured and bounded in the
  2026-07-24 campaign below.
- No new hardware acceleration was added: Graph already uses the canvas render
  path and prior profiling shows its remaining measured per-frame work is below
  the risk threshold. SIMD/GPU/threading changes would be platform-sensitive
  and speculative without device profiles.
- Remaining opportunities require native/device profiling, product decisions
  about first-open latency versus preloading, or high-risk dependency/cache
  changes; they fail the campaign's measurable-value and compatibility bar.

---

# Adaptive PDF efficiency campaign (2026-07-24)

Goal: reduce large-document memory, background preview CPU, page-paint React
work, and Edit Text latency without changing PDF pixels, file bytes, tools,
undo/save safety, native fallback behavior, dependencies, or public workflows.
The campaign started from the complete 2026-07-23 working tree and attributes
only the deltas below.

## Baseline

- Typecheck clean; 56 Vitest files / 507 passed + 1 intentionally skipped
  timing-only case.
- Production build: 447 modules in 2.55 s; startup entry 363.99 kB minified /
  118.45 kB gzip; full `dist/` 3.7 MB.
- Full suite: 3.75 s Vitest-reported duration / 4.24 s wall time.
- Installed npm tree: 343 MB; 27 root dependencies and 445 resolved tree nodes.
- PDF renderer retained one full-resolution scratch canvas **per page** in
  addition to every visible page canvas.
- PDF thumbnails retained one decoded 320 px-wide canvas per distinct path
  with no eviction, and every pointer-swept prewarm eventually rasterized.
- Page painting published a new React `Set` after every page.
- Edit Text rendered each page by filtering the document-wide text-run list:
  O(pages × runs), measured at 190.789 ms median for 500 pages / 50,000 runs.

## Pass 1 — bound PDF rerender scratch memory

- **Goal.** Remove duplicate per-page canvas backing while keeping old pixels
  visible until each replacement paint is complete.
- **Selection rationale.** This was the largest proven sustained allocation:
  it scaled with every rendered page and duplicated full-resolution RGBA
  backing. It outranked byte-copy and bundle micro-optimizations by orders of
  magnitude with lower compatibility risk.
- **Evidence/change.** `usePdfEditor` now creates one effect-local scratch
  canvas and reuses it sequentially across the pass. Each successor effect gets
  a different scratch, so cancellation cannot race a new pdf.js render on the
  same canvas.
- **Files.** `src/components/usePdfEditor.ts`,
  `src/lib/pdfBytes.test.ts`.
- **Compatibility.** Visible canvases are still untouched until the scratch
  paint completes; page order, yielding, blank-first-page detection, partial
  page repaint, cancellation, and fallback behavior are unchanged.
- **Metrics/memory.** Letter pages at scale 1.2 use about 2.66 MiB of RGBA
  backing each. Duplicate scratch backing becomes 26.6→2.7 MiB at 10 pages,
  133.0→2.7 MiB at 50, 266.0→2.7 MiB at 100, and
  1,330.0→2.7 MiB at 500 (90.0–99.8% reduction in this allocation).
- **Verification.** Typecheck plus seven targeted PDF hook/layering tests.
- **Risk.** Canvas allocation now occurs once per render effect rather than
  being retained; this deliberately trades negligible element creation for a
  very large sustained-memory reduction.
- **Next.** Bound decoded hover-thumbnail retention.

## Pass 2 — bound the decoded PDF thumbnail cache

- **Goal.** Prevent sustained preview memory from growing with every distinct
  PDF hovered during the process lifetime.
- **Selection rationale.** After Pass 1, this was the only remaining proven
  unbounded decoded-canvas cache on the PDF path.
- **Evidence/change.** The promise/canvas cache is now a 24-entry LRU. Cache
  hits promote their entry; late failures remove only their own promise so an
  invalidated/re-requested replacement cannot be deleted.
- **Files.** `src/lib/boundedLru.ts`,
  `src/lib/boundedLru.test.ts`, `src/lib/pdfThumb.ts`.
- **Compatibility.** The 24 most recent thumbnails remain instant; evicted
  entries rerender through the same byte/range-load and pdf.js path with
  identical pixels.
- **Metrics/memory.** A typical 320 px-wide Letter thumbnail is about
  0.505 MiB decoded. Retention is now typically bounded near 12.1 MiB instead
  of 50.5 MiB after 100 paths, 252.7 MiB after 500, or 505.4 MiB after 1,000.
- **Verification.** Typecheck plus nine LRU, PDF layering, and preview-trigger
  tests.
- **Risk.** Returning to a PDF beyond the 24-entry working set rerenders its
  thumbnail; this is a cache miss only, not a user-visible behavior change.
- **Next.** Stop stale queued prewarms from consuming background CPU.

## Pass 3 — make queued preview rendering latest-wins

- **Goal.** Avoid rasterizing PDFs the pointer has already left.
- **Selection rationale.** The cache bound fixed retention but a fast sidebar
  sweep could still enqueue hundreds of stale pdf.js jobs, consuming CPU long
  after the interaction ended.
- **Evidence/change.** A tested `LatestWinsQueue` lets the single active render
  finish safely, renders the newest queued path next, and rejects older queued
  interactions before their task starts. Returning to an already queued cache
  entry reprioritizes it. Intentional prewarm supersession is swallowed at the
  fire-and-forget trigger; visible `PdfThumb` keeps its existing error path.
- **Files.** `src/lib/latestWinsQueue.ts`,
  `src/lib/latestWinsQueue.test.ts`, `src/lib/pdfThumb.ts`,
  `src/components/previewTriggers.ts` and its test.
- **Compatibility.** Active pdf.js work is never cancelled, visible requests
  share/promote the cached promise, and the final pointer target renders through
  the same code.
- **Metrics/CPU.** A sweep across N uncached PDFs changes eventual
  rasterizations from N to at most two (active + newest): 80% avoided at 10,
  98% at 100, 99.6% at 500, and 99.8% at 1,000.
- **Verification.** Typecheck plus 13 queue/LRU/preview/layering tests,
  including duplicate same-path generations found during the second-pass audit.
- **Risk.** Superseded queued promises reject by design; all current
  fire-and-forget and visible consumers handle that rejection.
- **Next.** Remove per-page React completion publications.

## Pass 4 — keep page completion out of React state

- **Goal.** Prevent a full PDF component reconciliation after every painted
  page.
- **Selection rationale.** The canvases are painted imperatively and only the
  first page changes visible React UI by retiring the native warm-start iframe.
  Publishing every other completion had cost without a consumer.
- **Evidence/change.** The complete rendered-page set now lives in a ref.
  React state publishes only `firstPagePainted`; structural edits and
  document resets clear both together.
- **Files.** `src/components/usePdfEditor.ts`,
  `src/components/PdfView.tsx`, `src/lib/pdfBytes.test.ts`.
- **Compatibility.** Complete page tracking remains available, the first-page
  handoff occurs at the same point, and canvas painting/yield order is unchanged.
- **Metrics/CPU.** Completion publications become 10→1, 50→1, 100→1, and
  500→1 (90.0–99.8% fewer React updates).
- **Verification.** Typecheck plus 27 PDF render, transformation, and
  document-identity tests.
- **Risk.** None identified; later page completion has no declarative consumer.
- **Next.** Index text runs once instead of scanning them per page.

## Pass 5 — index Edit Text runs by page

- **Goal.** Make large text-PDF interaction linear in extracted runs.
- **Selection rationale.** With memory and background work bounded, the
  remaining reproducible UI-thread hotspot was the render-time
  `pages × textRuns` filter.
- **Evidence/change.** `groupPdfTextRunsByPage` builds a memoized page→runs map
  whenever extraction publishes a new array. Rendering performs one lookup per
  page and preserves source order and object identity.
- **Files.** `src/lib/pdfTextRuns.ts`,
  `src/lib/pdfTextRuns.test.ts`, `src/components/PdfView.tsx`.
- **Compatibility.** Hit boxes, order, keys, coordinates, text, and click
  handlers are unchanged.
- **Metrics/CPU.** The 500-page/50,000-run synthetic case drops from
  25,000,000 predicate checks and 190.789 ms median to one 50,000-run grouping
  pass plus 500 lookups, measured below 1 ms in the final run (about 95×+).
- **Verification.** Typecheck plus 29 text-index and PDF regression tests.
- **Risk.** The map retains only arrays of references to the already-resident
  runs; added memory is O(runs) references and is released with the source
  array.
- **Next.** No sixth change met the five-pass reliability threshold.

## Campaign result and stop decision

- The two dominant unbounded/linear memory paths are now bounded:
  per-render duplicate canvas backing is O(largest page), and retained
  thumbnails are O(24 recent paths).
- Rapid preview sweeps no longer create an arbitrarily long background
  raster queue.
- Large-document page completion causes one React update, and Edit Text
  rendering is O(runs + pages) rather than O(runs × pages).
- No dependency, native feature, API, CLI, file format, security, validation,
  diagnostics, accessibility, fallback, or save-integrity contract changed.
- Final verification: typecheck clean; 59 Vitest files / 516 passed + 1
  intentionally skipped timing case; graph perf 4/4; production build
  450 modules in 2.57 s; Rust 19/19 plus no-default-features build; production
  npm audit 0; universal app/DMG package; clean diff and privacy scans.
- Final bundles: entry 364.94 kB / 118.85 kB gzip; PDF view 453.15 kB /
  186.16 kB gzip; `dist/` 3.7 MB; universal app 14 MB; DMG 9,167,985 bytes.
- Startup, package, and dependency work was left unchanged because the prior
  campaign had already split every measured heavy optional surface and the
  remaining dependencies are feature-owned.
- Remaining candidates were rejected for this campaign: viewport
  virtualization changes scroll/layout semantics and needs physical device QA;
  pdf.js range-loading for the primary editable byte path changes worker/I/O
  ownership and needs heterogeneous-device profiling; form/text extraction
  scheduling changes tool timing; hardware/native/dependency changes are
  platform-sensitive; smaller byte-copy and blank-paint sampling changes do not
  outrank their regression surface without a device trace.

---

# Vault search pass (2026-07-25)

Goal: reduce the per-keystroke cost of full-text vault search, the app's most
interactive whole-vault operation. Reassessment of the whole tree picked this
over the remaining PDF/startup ideas: the entry chunk and PDF paths were
already split and bounded by the two prior campaigns, whereas search still
rescanned and re-lowercased the entire content cache on every keystroke.

Rejected first, with numbers, so they are not re-tread:

- **Bounding the vault-open per-file IPC fan-out** (`readNote` for every
  markdown file, `stat` for every file — both unbounded `Promise.all`, unlike
  the deliberately batched `walk`). Modelled against a bounded service pool:
  wall time is unchanged (queueing is work-conserving) and peak retained bytes
  are identical, because vault open retains every result by design. No
  measurable win without a native device trace; left alone.
- **Case-insensitive regex (`/term/gi`) instead of lowercasing.** Allocation-
  free, but **0.56–0.59x** — V8's `indexOf` over a lowered string beats a
  regex exec loop. Rejected.
- **Counting matches with an `indexOf` loop instead of `String.match`.**
  1.01–1.03x, inside noise. Not worth the churn.
- **Memoising the lowercased corpus across keystrokes.** 1.50–1.64x, but it
  doubles retained memory for the searched corpus, which contradicts the
  memory goal. Rejected in favour of narrowing, which costs nothing.

## Fix — case-insensitive matching (correctness)

- **Evidence.** `parseSearchQuery` returns the term with the user's casing
  intact, but `SearchSurface` compared it against `text.toLowerCase()` and
  `f.name.toLowerCase()`. A lowered string can never contain an uppercase
  character, so **any query containing a capital letter returned zero
  results** — searching `Budget` in a vault holding `Budget.md` whose body says
  "Budget" produced nothing. No test covered a capitalised query.
- **Change.** `searchVault` lowers the query as well as the text.
- **Verified in the browser demo.** `Graph` and `graph` now return the same
  six ranked notes with the same match counts; before, `Graph` returned none.

## Change — incremental prefix narrowing

- **Evidence.** The results memo scanned every file and allocated a full
  lowercased copy of every note on every keystroke: 11.7 MiB of transient
  string per keystroke at 2,000 notes, 29.3 MiB at 5,000.
- **Why it is safe.** Substring matching is monotone under prefix extension: if
  `term2` starts with `term1`, every file containing `term2` contains `term1`,
  so `matches(term2) ⊆ matches(term1)` and the rest of the vault provably
  cannot match. Each keystroke therefore only rescans the previous survivors.
- **Change.** The matching logic moved out of the component into pure
  `searchVault` (`src/lib/search.ts`), which returns a `SearchPass` carrying
  the uncapped survivor set. `SearchSurface` holds the last pass in a ref and
  drops it whenever `files` or `contentCache` changes identity, so an edited
  note can never stay wrongly excluded. Any other mismatch — backspace, paste,
  a changed `ext:` filter, or a pass that never scanned — falls back to a full
  scan on its own.
- **Numbers (real implementation, 2% hit rate, typing "budget" = 5
  keystrokes).** 2,000 notes / 11.7 MiB: **21.45 → 4.93 ms (4.4x)**.
  5,000 notes / 29.3 MiB: **55.46 → 13.16 ms (4.2x)**. Transient lowercased
  allocation over the sequence drops **78%** (58.6 → 12.7 MiB at 2,000 notes).
  Retained memory is unchanged — nothing new is cached.
- **Parity.** Narrowed passes are asserted equal to full scans for growing and
  shrinking terms, across an `ext:` filter change, and from a never-scanned
  pass. `candidates` is kept uncapped: a regression test with 140 matching
  notes where the only narrower match sorts last proves the 100-hit display cap
  cannot drop it. A Proxy-based test pins that narrowing reads only survivors.
  Round-trip parity (`gr` → `graph` → `gr`) was also confirmed live in the
  browser demo, counts included.

## Result

- Files: `src/lib/search.ts`, `src/lib/search.test.ts`,
  `src/components/SearchSurface.tsx`, `src/lib/AGENTS.md`.
- Entry chunk unchanged at 364.94 kB / 118.85 kB gzip (search is lazy);
  `SearchSurface` chunk 2.99 → 3.36 kB.
- Verification: typecheck clean; 59 files / **527 passed** + 1 skipped (was
  516); production build clean; browser-demo GUI exercised with zero console
  errors.
- No dependency, API, CLI, file format, security, validation, diagnostics, or
  accessibility contract changed. Search ranking, snippets, the `ext:`/`type:`
  filters, the 2-character minimum, and the 100-result cap all behave as before.

---

# Tasks dashboard pass (2026-07-25)

Goal: stop the Tasks dashboard from re-parsing the whole vault on every
keystroke-debounce. Selected after the search pass because it is the same class
of defect on the other always-mountable whole-vault surface — the Tasks panel
docks as a persistent workspace pane, so its cost lands while the user types.

- **Evidence.** `TasksPanel`'s memo keys on `[notes, cache, tasksFile]`, and the
  content cache's identity is replaced by every debounced editor save. Each pass
  re-ran `parseTasks` over every note — `content.split("\n")` allocating a line
  array for the entire vault. Measured vault-wide pass: **15.2 ms at 2,000
  notes / 8.6 MiB** and **39.5 ms at 5,000 notes / 21.4 MiB**, at up to 2 Hz
  while typing, to recompute a result that differs in exactly one note.
- **Change.** The vault-wide loop moved out of the component into pure
  `collectVaultTasks` (`src/lib/tasks.ts`), which memoises each note's parse on
  its exact content string, title, and personal/agent tag. A save re-parses only
  the note that changed. The memo is rebuilt each call from the notes still
  present, so a deleted note stops retaining its content, and
  `store.openVault` calls `resetVaultTaskMemo` so switching vaults cannot
  strand the previous vault's text.
- **Numbers (real implementation, one note edited per pass).** 2,000 notes:
  **15.37 → 0.73 ms (21x)**. 5,000 notes: **39.20 → 0.90 ms (44x)**. The
  residual is the memo rebuild and flattening, which scales with note count
  rather than vault bytes. Retained memory grows only by the parsed task
  objects; note text was already retained by the content cache.
- **Parity.** Pinned against a verbatim copy of the pre-memo implementation,
  plus tests for tag/title invalidation, notes with no cached content, notes
  leaving and returning to the vault with different content, and a post-reset
  pass. `TaskItem`s are now shared across passes and documented read-only;
  `groupTasks`/`bucketTask` only read and the dashboard filters into new arrays.
- **Verified in the browser demo.** Adding two personal tasks updated the
  dashboard each time (Personal 0→1→2), and marking one Done through the board
  moved the count 2→1, flipped the card to `done`, and switched its action to
  Reopen — so every mutation path invalidates correctly. Zero console errors.

## Result

- Files: `src/lib/tasks.ts`, `src/lib/tasks.test.ts`,
  `src/components/TasksModal.tsx`, `src/store.ts`, `src/lib/AGENTS.md`.
- Verification: typecheck clean; 59 files / **534 passed** + 1 skipped (was 516
  at the start of the day); production build clean; browser-demo GUI exercised.
- No dependency, API, CLI, file format, security, validation, diagnostics, or
  accessibility contract changed. Task parsing, tagging, bucketing, ordering,
  and the personal/agent split all behave as before.
