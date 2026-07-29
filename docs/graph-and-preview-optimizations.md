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

# PDF first meaningful paint pass (2026-07-28)

Goal: reduce the delay from selecting a PDF to seeing the first Mesa-rendered
page, without weakening data integrity. The accepted optimization deliberately
keeps the byte-backed pdf.js document as the rendering authority and leaves
edit/save validation unchanged.

## Architecture discovered

- PDF opens route through `MediaView`/`DocumentView` into lazy `PdfView`.
- `usePdfEditor` reads exact bytes (`readFile` in Tauri, `fetch` in the browser
  demo), snapshots the saved baseline, gives a copied/sanitized buffer to
  `pdfjs.getDocument`, and renders pages to canvases.
- The native PDF URL is a warm-start/fallback surface. It is not the edit/save
  authority.
- Editing and saving remain byte transforms over the hook's current
  `Uint8Array`, then `persistPdfBytes` and `persistVerifiedBytes`.

## Baseline bottleneck found in code

- Before this pass, `PdfView` created page wrappers/canvases for every page as
  soon as `pageCount` was known.
- The render effect then built a full document page-number list and called
  `doc.getPage()`/`getViewport()` before discovering whether the page canvas
  existed.
- That serialized full-document page discovery and large DOM creation ahead of
  page 1 under load. The cost scales with page count and worsens when the main
  thread, pdf.js worker, or memory allocator is contended.

## Accepted change

- `PdfView` now mounts page 1 first. After `firstPagePainted`, it mounts the
  remaining page shells in small batches.
- `usePdfEditor` renders only mounted canvases. If no mounted canvas is present,
  the render pass records a skipped measurement event and does no pdf.js page
  work.
- A bounded in-memory timeline (`window.__MESA_PDF_PERF__`) records open,
  bytes-read, pdf.js parse, canvas mount, page-1 raster, first meaningful page,
  total render, form-field, and text-extraction events. It stores relative path,
  extension, size, timings, and counts only.
- `scripts/pdf-perf-browser.mjs` drives the browser demo and reports the
  in-viewer timeline plus long-task, canvas-count, and Chromium heap samples
  when Playwright is available locally.

## Reliability boundary

- No streamed/range-loaded document was promoted into the primary render path.
  That was intentionally rejected for this pass because it could make the
  early visible page diverge from the exact byte snapshot used for editing and
  saving unless additional consistency checks are designed.
- Save, undo/redo, pdf-lib validation, stale-write blocking, generation/path
  guards, blank-first-page fallback checks, and verified vault writes are
  unchanged.

## Verification

- Focused PDF regression: `npm test -- usePdfEditor pdfBytes pdfTextRuns
  pdfStalePages pdfThumb latestWinsQueue boundedLru` = 55 passed, including a
  mocked five-page assertion that the first paint path asks pdf.js for page 1
  only after the first canvas mounts.
- Full checks: `npm run typecheck` passed; `npm test` = 74 files, 766 passed,
  1 skipped; `npm run test:perf` = 4 passed; `npm audit --omit=dev` found 0
  vulnerabilities; `git diff --check` passed.
- Production build: `npm run build` = 458 modules in 2.63 s.
- Browser timing used production preview (`npm run preview`) plus
  `scripts/pdf-perf-browser.mjs` with bundled Playwright. On the deterministic
  one-page fixture, five normal runs measured first meaningful page at
  95.4-126.6 ms (median 114.3 ms), bytes read at 3.0-7.1 ms, pdf.js parse at
  65.4-100.7 ms (dominant stage), page-1 raster at 13.9-17.7 ms, one canvas,
  and no long tasks. Three runs after a synthetic 120 ms pre-open main-thread
  block measured first meaningful page at 114.8-117.5 ms with no long tasks
  during the PDF render path. A post-helper-change production run verified the
  console-error and page-error captures, both empty.
- Dev-server timing intentionally was not used as the final latency number:
  React development effect replay produced duplicate byte-read events and
  247-537 ms first-page samples that do not reflect production preview.
- Repeatable commands:

```bash
npm run build
npm run preview -- --host 127.0.0.1
NODE_PATH=/path/to/node_modules node scripts/pdf-perf-browser.mjs --url=http://127.0.0.1:4173/ --runs=5
NODE_PATH=/path/to/node_modules node scripts/pdf-perf-browser.mjs --url=http://127.0.0.1:4173/ --runs=3 --main-thread-block-ms=120
```

## Remaining work

- Repeat native desktop QA against the user's exact vault when requested; the
  browser demo is not same-vault acceptance evidence.
- Consider a future range-load first-paint design only if it can prove byte
  consistency with the edit/save snapshot before exposing edit controls or
  claiming the visible page is authoritative.

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

---

# Document-pipeline reliability pass (2026-07-27)

Three rounds over the document handling pipeline, PDFs first. Baseline re-run
green BEFORE any edit rather than trusted from the checkpoint: typecheck clean ·
63 files / 570 passed + 1 skipped · entry gzip **120.77 kB** · PdfView chunk
185.97 kB.

## Round 1 — a failed rollback no longer destroys the original

`persistVerifiedBytes` restores the verified backup when a committed write reads
back wrong, then removed that backup in `finally` **unconditionally** — including
when the restore itself had just failed. Reproduced against the real primitive
with an fs whose target writes land empty (the full-disk shape: the condition
that breaks the commit breaks the rollback too):

    error: Final PDF write verification failed.
    files on disk after failure:
       /v/report.pdf -> 0 bytes []

The original bytes and the backup were both gone — exactly the "unrecoverable
from within Mesa" case the PDF-corruption checkpoint describes. Now a failed
rollback preserves the backup as a `rescue` artifact and names its path in the
error. Promotion is by `rename` first (copying a 52 MiB PDF needs space a full
disk does not have), falling back to a verified copy, then to keeping the backup
under its own name — exactly one copy survives every failure branch.
`planWriteRecovery` restores a stale rescue whose target is missing and **never**
removes one whose target exists, unlike a backup: it sits beside bytes Mesa
could not verify.

Applies to every vault write, not just PDFs. Pinned by 5 new tests, each
confirmed to FAIL against the pre-fix source.

## Round 2 — non-Latin text fails with an explanation, not `WinAnsi cannot encode`

Mesa stamps text with pdf-lib's standard fonts (WinAnsi/Latin-1). Probed the real
encoder: Greek, Cyrillic, CJK, emoji, and `→` all throw
`WinAnsi cannot encode "α" (0x03b1)` — surfaced verbatim as
`Edit failed: Error: WinAnsi cannot encode …`. Reachable without typing anything:
Edit Text pre-fills from text extracted from the document itself.

`assertTextEncodable` now runs before the document is touched (so a rejected
replacement never even paints its white-out box) and names the offending
characters as `"α" (U+03B1)`. It asks a cached throwaway-document standard font
what it accepts rather than keeping a second coverage table that could drift, and
skips the layout characters pdf-lib normalizes itself (`\t\n\r\b\f`) — verified
by probe, so text that works today cannot be newly rejected.

Correction found while testing: the first draft assumed a save rebuilds every
field's appearance, so one pre-existing Cyrillic field would break an unrelated
ASCII edit. Probing disproved it — pdf-lib only rebuilds fields the edit dirties.
The claim was removed from the code comment and the test replaced with one
pinning the real behavior: a form seeded with a UTF-16BE Cyrillic value stays
editable.

## Round 3 — bound undo/redo retention

Every PDF history entry is a full document copy, and nothing bounded the stacks.
Measured on `tmp/pdfs/corpus` with ten highlight edits:

| document | retained before | retained after | undo depth |
| --- | --- | --- | --- |
| text-heavy (36 KiB) | 0.3 MiB | 0.3 MiB | 10/10 unchanged |
| scanned (2.4 MiB) | 28.6 MiB | 28.6 MiB | 10/10 unchanged |
| image-heavy (52 MiB) | **625.6 MiB, linear** | **156.4 MiB, flat** | 1 |

Thirty edits on the large document would have been roughly 1.8 GiB. New pure
`src/lib/pdfHistory.ts` trims oldest-first by total retained BYTES (128 MiB,
200 entries) rather than by depth, which is what leaves ordinary documents
completely untouched. The remaining 156.4 MiB is the irreducible floor —
current + saved baseline + one retained snapshot — and no longer grows with edit
count. Both stacks are bounded: bounding only undo moves the leak into redo,
which fills as the user undoes. The newest entry is never dropped, so one undo
survives on a document larger than the whole budget.

## Round 4 — stop judging bytes Mesa did not author

`persistVerifiedBytes` ran the caller's `validate` at every stage, including
`Backup`. For PDFs that meant the ORIGINAL had to satisfy Mesa's own format
check before an edit could be saved. Reachable: a PDF carrying more than 4 KiB
of debris after `%%EOF` (incremental-update leftovers, a server footer) fails
`hasPdfEofMarker` while pdf-lib parses and edits it happily. Confirmed against
the real save path — Mesa opened it, edited it, then failed every save with
`Backup PDF write verification failed.`, a message implying a disk fault.

`validate` now judges only the stages Mesa authored (`Temporary`, `Final`).
`Backup`/`Restore`/`Rescue` hold the user's existing bytes, whose fidelity the
byte-for-byte equality check already proves. Invalid candidate bytes are still
rejected before and after the commit.

Measured for honesty: this removes one pdf-lib parse per save, worth 0.3 ms
(1 KiB) to 15.0 ms (52 MiB) — pdf-lib parses lazily. The value here is
correctness, not speed.

## Round 5 — extract PDF text once, project it per zoom

`usePdfEditor` baked screen-space geometry into each extracted text run at the
current render scale, so `renderScale` sat in the extraction effect's deps and
every settled zoom re-ran pdf.js extraction across the whole document. Measured
cost of one pass: **81.3 ms for a 40-page / 3,320-run document** (~1 s at 500
pages).

Extraction now runs once per parsed document at scale 1 into a zoom-independent
`PdfTextRunSource`, and `projectPdfTextRun` derives the screen geometry. The
viewport transform is linear in the scale, so this reproduces the previous
numbers exactly: verified against the old code over the real corpus at four
zoom levels — **106,368 field comparisons, maximum deviation 4.55e-13 px** —
and pinned in `pdfTextRuns.test.ts` against a verbatim copy of the pre-split
implementation across five run shapes (missing extents, sub-8px, degenerate
transform, skewed matrix) and five scales. The `Math.max` clamps stay after
scaling; hoisting them to scale 1 would change sub-8px run geometry.
`PdfView` is unchanged — it still receives the same `PdfTextRun` shape.

Confirmed at the hook level: zooming once triggered **2** `getTextContent`
passes and now triggers **1**, with PDF-space coordinates (what `replaceText`
writes with) provably identical across zoom levels.

## Round 6 — a zoom no longer steals the edit's page-scoped repaint

The render effect consumed `renderPageOverrideRef` on whichever pass ran first.
It re-runs for zoom settles and canvas remounts as well as document changes, so
a zoom landing between an edit and its reparse repainted ONLY the edited page at
the new scale and left every other page's viewport measured for the old one.

An earlier assessment in this session called this a self-healing transient. That
was too generous: the wrong state persists until the reparse completes, which on
a large document is real time. Demonstrated by holding the parse open — after
zooming 1.2 → 2.4, page 0's viewport width stayed **360 instead of 720**.

Only a pass where `doc` actually changed may now consume the override; every
other pass repaints in full and leaves the override for the reparse.

## Round 7 — re-extract only the page an edit touched

Extraction was still all-or-nothing per parsed document, and every edit produces
a new document — so each stamp/highlight/ink stroke re-ran the full 81.3 ms pass
from Round 5. `pendingTextPagesRef` now accumulates which pages an edit
invalidated and the effect re-extracts just those, merging with
`mergePdfTextRunSources`.

The safety rules are the whole design, because a stale run places a replacement
on the wrong glyphs:

- Only page-scoped, non-structural edits narrow the set. Structural edits,
  undo, redo, and external reloads mark `"all"` — page indices can shift.
- `"all"` always wins when merging pending work.
- Reuse additionally requires the cached page count to match the document's.
- A pass consumes the pending set up front and hands it back if cancelled
  before publishing, so a cancelled full pass cannot be silently downgraded to
  a partial merge over stale sources.

Measured through the hook on a 3-page document: a page-scoped edit re-extracted
pages `[1,2,3]` before and `[2]` after; a structural edit and an undo still
re-extract everything.

## Result

- Files: `src/lib/verifiedWrite.ts`, `src/lib/writeRecovery.ts`,
  `src/lib/vault.ts`, `src/lib/pdf.ts`, `src/lib/pdfHistory.ts` (new),
  `src/components/usePdfEditor.ts`, `src/lib/pdfTextRuns.ts`,
  `src/lib/pdfSave.test.ts`, their tests, plus `docs/vault-safety.md`,
  `docs/pdf-editing.md`, root/lib/components AGENTS.
- Verification: typecheck clean; 64 files / **608 passed** + 1 skipped (was 570);
  production build clean; entry gzip 120.77 → **120.94 kB** (+0.17), PdfView
  185.97 → **186.99 kB** (+1.02) for the new contracts. Graph perf 4/4,
  `npm audit` 0, `git diff --check` clean.
- No dependency, native flag, API/CLI, file format, sync, or accessibility
  change. Undo depth on documents large enough to exhaust the webview is the
  one deliberate behavior change, and it replaces a crash.

## Round 8 — browser-first PDF regression and sparse-paint correctness

The browser demo had no PDF, so none of the PDF open/render/edit/history
workflow could be observed in the environment designated as the acceptance
gate. Added one deterministic local `Mesa PDF Tour.pdf` plus stable
`PdfView` test IDs. The first real replay immediately found a defect the green
unit/type checks had missed: pdf.js painted the sparse Letter page correctly,
but Mesa's 32×32 blank-pixel grid missed every mark. Because the page had a
non-empty operator list, Mesa called that a broken render, discarded its
canvases, and fell back to the native iframe.

The new sparse-content test was confirmed failing against the pre-fix function.
The grid is now a fast path only; when it appears blank, Mesa scans the complete
pixel buffer already materialized by `getImageData`. A blank 734×950 first page
measured **1.70 ms mean** for the fallback scan over 100 local runs; normal
pages that hit the grid do not pay it.

Browser replay after the fix:

- page 1 painted at 734×950 with no fallback iframe or error;
- Edit PDF opened; `+ Page` produced two numbered 734×950 canvases;
- Undo returned to one page and `Saved`; redo returned to two and `Save`;
- browser-demo Save reported its intentional read-only status;
- no new console/worker warning or error appeared; visual inspection showed
  the fixture text and vector rectangle correctly.

The shared architecture map and permanent workflow live in
`docs/document-architecture.md`; `vault.test.ts`, `pdf.test.ts`, and
`pdfBytes.test.ts` pin the fixture, sparse-paint behavior, and automation hooks.

Final supporting checks: typecheck clean; **65 files / 631 passed + 1 skipped**;
graph perf 4/4; production build clean (entry **121.08 kB gzip**, PdfView
**187.12 kB gzip**); the 679-byte public fixture copied byte-identically into
`dist/`; Rust 21/21; offline audit 0; `git diff --check` clean. A live registry
audit could not run under the environment's external-metadata egress policy;
no workaround was used.

## Round 9 — one PDF implementation in every document window

The architecture map exposed a second PDF renderer: the main workspace used
`PdfView`, but standalone/popout document windows used a raw `doc-pdf` iframe.
That bypassed the sparse-paint fix, Mesa's editable canvases, undo/redo, and the
verified save path. It also duplicated file classification in
`DocumentView.tsx` and read every non-image/video/PDF format through the text
loader regardless of the shared vault contract.

`DocumentView` now dispatches through the shared `fileKind`, only reads
`isTextualVaultFile` files as text, and lazy-loads the same `PdfView` used by
the workspace. `PdfView` accepts an optional explicit `VaultFile` from a
standalone scan while retaining store resolution in the main workspace. A
source contract pins the lazy boundary, explicit file handoff, and absence of
the old iframe-only branch.

Browser acceptance was replayed on both surfaces:

- standalone `?doc=Mesa%20PDF%20Tour.pdf&vault=mesa%3A%2F%2Fdemo`: one
  734×950 canvas, zero `doc-pdf`/fallback frames, then add page → undo → redo →
  read-only browser Save;
- main workspace: the same sequence produced 1 → 2 → 1 → 2 canvases and the
  same intentional read-only status, with no fallback frame.

Closeout checks after this unification: typecheck clean; **65 files / 632
passed + 1 skipped**; graph perf 4/4; production build clean (entry **121.08 kB
gzip**, PdfView **187.21 kB gzip**); Rust 21/21; offline audit 0. The only
production-build advisory is the existing large-chunk notice.

---

# Interactive-latency pass on a real vault (2026-07-28)

Every prior campaign in this document was measured on the 9-note browser demo or
on synthetic corpora. This pass was measured on a real lived-in vault —
**4,165 files / 721 notes / 13.5 MB of markdown / 1,629 PDFs / 1,506 `.txt`,
200 folders, largest note 420 kB** — loaded into the real UI. That changed the
ranking completely: the two dominant interactive costs were both invisible at
demo scale.

Method: the vault's real scan output, note metadata and content cache were
injected into the running store, so every number below comes from the actual
React/CodeMirror/markdown-it stack rendering real data, not from a model.
Baseline and result were measured **back to back in one session** by reverting
the three touched files to `HEAD` and replaying the identical protocol, because
absolute timings on this machine drift between page loads. Numbers are Vite dev
builds with `StrictMode` double-rendering, so treat them as an upper bound and
trust the deltas.

## Baseline (real vault, measured, not claimed)

| interaction | cost |
| --- | --- |
| switch between two ~3 kB notes (median of 5) | **1,222 ms** blocked |
| type 5 characters in the 420 kB note | **693 ms** blocked, longest task **540 ms** |
| one preview render of the 420 kB note | 54.7 ms (markdown-it 13.9 + DOMPurify 17.8 at 100 kB, both linear) |
| status-bar word count per keystroke | 4.41 ms |
| `activePath` change with 4,165 rows mounted | 205–251 ms, for **5 DOM mutations** |
| `activePath` change with 4 rows mounted | 0 ms |

## Round 1 — take the preview render off the keystroke's critical path

- **Evidence.** `MarkdownView` rendered `source` — the store's live editor text
  — synchronously inside the keystroke's own commit. On the 420 kB note that is
  a 54.7 ms markdown-it + DOMPurify pass before the caret can move.
- **Change.** `useDeferredValue(source)`: the keystroke commits and paints with
  the previously rendered HTML, the render runs at transition priority, and a
  keystroke arriving before that task starts discards it rather than queueing
  another full pass. The DOM-wiring effect keys on the deferred value too, so it
  runs once per rendered document instead of once per keystroke.
- **Measured in isolation** (5 real keystrokes, clean page): one **592 ms**
  blocking task became **74 ms + 128 ms** — total −66%, longest block −78%.
  React discarded superseded renders, so this is real CPU removed, not latency
  moved.
- **Parity.** The settled preview is always the latest `source`; only the frame
  it lands on changes. Verified live: after typing into the 420 kB note the
  preview contained the typed text and the status bar tracked the new length.

## Round 2 — the status bar stops allocating a copy of the note per keystroke

- **Evidence.** `content.trim() ? content.trim().split(/\s+/).length : 0` runs
  on every render of an always-mounted bar that subscribes to the live text:
  two full 420 kB copies plus a 74,883-element array of short strings, per
  character. Memoizing does not help — `content` changes every keystroke.
- **Change.** New pure `lib/wordCount.ts`: `countWords` scans once and allocates
  nothing. The asset count is memoized on `files` (which cannot change while
  typing) instead of filtering 4,165 entries into a throwaway array per render.
- **Numbers.** 4.63 → 3.17 ms on the 420 kB note, and zero allocation.
- **Parity pinned by test.** `wordCount.test.ts` asserts `isMarkdownWhitespace`
  equals the ECMAScript `\s` class for **all 65,536 BMP code points** (which is
  what makes it agree with `String.prototype.trim`), plus 18 shape cases and a
  200-trial randomized whitespace fuzz against the original expression. Verified
  live against the vault: **0 mismatches over all 721 notes / 2,045,377 words**.

## Round 3 — one file switch stops re-rendering the whole sidebar

- **Evidence.** The sidebar is not windowed: all **4,165** rows are live
  `TreeItem` components (12,352 DOM nodes). A `MutationObserver` showed a file
  switch producing exactly **5 DOM mutations** — the two `.active` class flips
  and the backlinks panel — while blocking **205 ms**. Collapsing every folder
  (4 rows mounted) took the same switch to **0 ms**, proving the cost was the
  mounted rows, not the store fan-out (changing `status` or `content` with all
  4,165 rows mounted costs 0 ms).
- **Three causes, all required.** (1) `App` subscribes to `activePath` and
  `FileTree` was not memoized, so a parent re-render walked the entire tree.
  (2) `FileTree` itself subscribed to `activePath` and `collapsedFolders`, which
  its render never reads — only the reveal effect, which is deliberately keyed
  on `revealTick` alone. (3) Each `TreeItem` selected the shared `s.activePath`
  string and the whole `s.collapsedFolders` map, so the selected value changed
  for every row even though only two rows change appearance.
- **Change.** `memo(FileTree)`; the reveal effect reads both values from
  `getStore()` at event time (also fresher — it reveals the file that is active
  when ⌖ is pressed); each `TreeItem` selects the derived booleans it renders.
- **Numbers (back-to-back A/B, same session).** File switch **1,222 → 109 ms**
  median (−91%), worst of five 1,424 → 244 ms. The isolated `activePath`
  update went **205 → 0 ms**. Typing in the 420 kB note also improved, since
  `App` re-renders on `content` too: **693 → 542 ms** total with the longest
  single block **540 → 234 ms (−57%)**.
- **Compatibility verified live on the real vault**, not just by unit test:
  active-row highlight lands on exactly one correct row; folder collapse/expand
  4,165 → 4,162 → 4,165; bookmark toggle applies and removes the row class;
  sort-direction flip reorders and restores; `type:pdf` filter narrows to 1,629
  rows (all PDFs) and restores to 4,165.

## Round 4 — search covers every textual file, and got cheaper doing it

The finding below was originally recorded as "not changed" pending a product
decision on memory. The decision came back: search must cover all file types,
support phrases, stay lightweight, and keep every existing feature.

- **The bug.** `openVault` filled `contentCache` for `f.isMarkdown` only, while
  `searchVault` reads the cache for EVERY scanned file. In this vault that left
  **1,731 textual files** — 1,506 `.txt` (29.9 MB, more text than all the
  markdown), 78 `.html`, 52 `.py`, 38 `.json`, 33 `.js`, 10 `.csv` — matchable
  by NAME only. Reproduced: the phrase "hidden assumptions" sits in
  `Fable System Prompt 1.5k Tokens.txt`; search returned only a `.md` file. It
  was also inconsistent rather than merely incomplete — opening that `.txt`
  cached it lazily, and the same query then returned 2 hits instead of 1.

- **Why the obvious fix was not shippable.** Caching every textual file was
  measured first: it fixed the bug, but the corpus went 13.5 M → 61 M characters
  and search collapsed — typing an 8-character query went **151 → 744 ms** and a
  cold two-character term **77 → 290 ms**. That change was reverted before going
  further; making search cheap was a precondition, not an afterthought.

- **The matcher.** `searchVault` lowercased every scanned file on every
  keystroke — a full copy of the corpus per character. New `lib/searchMatch.ts`
  scans the RAW text with one reusable regex of per-character classes, so
  nothing is allocated. It is exactly equivalent because of two facts, each
  pinned by an exhaustive sweep of all 65,536 BMP code points: **U+212A KELVIN
  SIGN** is the ONLY non-ASCII code point whose `toLowerCase()` is ASCII
  (`"k"` — folded into the `k` class), and **U+0130** is the ONLY code point
  whose lowercase changes length (text containing it, and any non-ASCII query,
  falls back to the exact `toLowerCase()` path). Counting uses `test`, not
  `exec`, so a common two-letter term does not allocate a result array per hit.
  Matching on raw text also FIXES a latent defect: the old code took `idx` from
  the lowered string and sliced the RAW string with it, so a file containing
  U+0130 before the hit produced a snippet cut at the wrong offset.

- **The budget.** `lib/textCachePlan.ts` picks the extra files from the scan's
  own `size` metadata before any read, in `files` order, so the set is
  deterministic and no file is read only to be discarded. Markdown is never
  budgeted (`buildNotes` needs all of it). Anything excluded is counted into
  `store.unindexedTextFiles` and shown in the search UI, so incomplete coverage
  is never silent. This vault needs 45.5 MiB and skips nothing.

- **Phrases.** Matching was always plain substring, so multi-word queries were
  already phrase searches — but typing the quotes people naturally reach for
  searched for the quote characters too. `parseSearchQuery` now unwraps a fully
  quoted phrase, including alongside a filter (`ext:txt "hidden assumptions"`).
  An unbalanced or inner quote is still treated literally.

- **Numbers on the real vault** (61,009,854 characters cached, 2,452 files):

  | | markdown only (old) | all types, old matcher | all types, new matcher |
  | --- | --- | --- | --- |
  | typing "password" (7 keystrokes) | 151.4 ms | 744.2 ms | **284.9 ms** |
  | cold two-character term | 77–84 ms | 289.6 ms | **106.4 ms** |

  Search now scans **4.5× more text** for **1.9×** the cost of the old
  markdown-only pass, and is **2.6×** faster than the naive all-types version.
  `SearchSurface` already defers its query, so passes run at transition
  priority and superseded ones are discarded.

- **Parity, measured not assumed.** A verbatim copy of the pre-change matching
  loop was run against the new one over the real corpus for **41 queries** —
  case variants, `İstanbul`, `café`, `日本語`, emoji, regex metacharacters
  (`$5`, `[[`, `c++`, `(net)`, `a.b`, `x*y`, `re?`, `end$`), every `ext:`/
  `type:`/`.ext` form, and single-character terms: **0 rank/count/candidate
  mismatches, 0 snippet differences**, plus **0** narrowing mismatches across
  four progressively typed words. Unit side: 28 matcher tests (incl. a
  400-trial fuzz whose alphabet contains `İ`, `K`, `é` and metacharacters),
  9 budget tests, 18 search tests.

- **Verified in the real UI**, demo vault: `"living map"` returns Welcome with
  the correct snippet and count; `served from memory` returns **spark (SVG)** —
  a non-markdown file matched on its CONTENT, which returned nothing before.

- **Cost.** Retained text goes from 13.5 M to 61 M characters on this vault
  (~45.5 MiB of additional file bytes) and vault open performs 1,731 extra
  reads. That is the honest price of searching inside those files, and it is
  bounded and reported.

## Findings recorded but NOT changed

- **Full-text search cannot see 1,731 of the vault's textual files.**
  `openVault` populates `contentCache` for `f.isMarkdown` only, but
  `searchVault` scans every file and `isTextualVaultFile` claims a much wider
  set. In this vault that is **1,506 `.txt` (29.9 MB — more text than all the
  markdown), 78 `.html`, 52 `.py`, 38 `.json`, 33 `.js`, 10 `.csv`, …**.
  **(SUPERSEDED — fixed in Round 4 above.)**
  Reproduced: the phrase "hidden assumptions" is in
  `Fable System Prompt 1.5k Tokens.txt`; search returns only a `.md` file. It is
  also *inconsistent*, not merely incomplete — opening that `.txt` once caches
  it lazily, and the same query then returns 2 hits instead of 1, so results
  depend on session history. Fixing it is a real trade-off (roughly +30 MB
  retained and ~1,700 extra reads at vault open here) and needs a product
  decision, so it is left for a follow-up rather than decided silently.
- **(SUPERSEDED — Round 4.)** **Search costs 20–30 ms per keystroke** on this vault (77–84 ms for a cold
  two-character term): the narrowed candidate set is small in count but large in
  bytes (133 files / 5.37 M chars), and each keystroke re-lowercases all of it
  and allocates a full `String.match` array only to read `.length`. A
  case-insensitive regex scan measured ~4× faster, but `/i` and
  `toLowerCase()` disagree on characters such as U+212A KELVIN SIGN, so it is a
  silent behavior change and was not taken without a parity plan.
- **Deep Research is ~31 kB minified of the 379 kB entry chunk**
  (`deepResearch.ts` 22.25 + diagnostics 5.54 + run 1.79 + webArchive 1.41), all
  reachable only from async store actions and therefore deferrable. Not done
  here: it requires editing `store.ts`, which had substantial uncommitted work
  in progress during this pass.
- **Tree virtualization** would remove the remaining 4,165 fibers and 12,352 DOM
  nodes, but changes scroll/keyboard/drag semantics and needs device QA.

## Verification

`npm run typecheck` clean · `npm test` **71 files / 723 passed + 1 skipped**
(was 68 / 661) · `npm run build` clean, entry gzip 124.08 → 124.40 kB · `npm
audit` 0 · `git diff --check` clean · real-vault library-level probes and
demo-vault GUI exercised for every behavior listed above, with zero console
errors on a fresh load.

## Still open after this pass

- **Tree virtualization** would remove the remaining 4,165 fibers and 12,352
  DOM nodes. It changes scroll/keyboard/drag semantics and needs device QA.
- **Deep Research is ~31 kB minified of the entry chunk**, all reachable only
  from async store actions and therefore deferrable; deferring it means a
  larger edit to `store.ts`.
- **Vault open now performs 1,731 extra reads** on this vault. Bounding or
  backgrounding that fan-out was modelled in the 2026-07-25 pass and rejected
  as unmeasurable without a native device trace; worth re-measuring now that
  the read set is larger.

# Whole-vault reliability + interaction pass (2026-07-28)

Measured on the same real vault as the pass above — **4,165 files / 721 notes /
1,629 PDFs / 1,506 `.txt` / 61,009,854 cached characters across 2,452 files** —
with the library-level stages driven over the vault's actual bytes. The
previous pass had just widened the content cache from markdown to every textual
file; three of the five findings below are consequences of that widening that
only appear at this scale, and the first is data loss.

Baseline re-run before editing, not trusted from the checkpoint: typecheck
clean · 71 files / 723 passed + 1 skipped · entry gzip 124.40 kB.

## Round 1 — an externally edited `.txt` was never seen again (data loss)

- **The bug.** The watcher's modify branch refreshed `contentCache` for
  `file.isMarkdown` only. Its own doc comment claimed it kept the content cache
  in sync "for ALL file types". Once `planTextCache` caches 1,731 non-markdown
  textual files at vault open, an external edit to any of them — another tool, a
  synced device, an agent, a git checkout — left Mesa holding the old bytes for
  the whole session. No other path refreshes them: `refreshMissingExternalFiles`
  only handles ADDITIONS and caches only markdown; `registerExternalFile` does
  not cache non-markdown at all.
- **Why it is data loss, not stale display.** `selectFile` serves a cached entry
  synchronously and only reads from disk when the entry is `undefined`, so the
  editor opens the stale copy. Neither the debounced save nor `flushSave` passes
  `expectedCurrentContent`, so `writeNote` runs with **no** precondition — one
  keystroke and a blur write the stale text back over the newer file. Search
  meanwhile matched text no longer on disk and could not find text that was.
- **Fix.** `needsCachedTextRefresh` (`vault.ts`), the read-side mirror of
  `flushableNoteText`: refresh any textual file Mesa is HOLDING; a file with no
  entry returns false, so the vault-open budget is not quietly bypassed and a
  binary is never re-read as text. The document being typed in is left alone —
  the same rule the markdown branch already used.

## Round 2 — a bulk external change committed once per file

- **Evidence.** Watcher events arrive coalesced (60 ms window), so a sync, a
  bulk agent write, or a git checkout delivers hundreds of paths in one batch.
  Each path ran its own `set()` spreading the whole content cache and notes map,
  plus a fresh `files` array — O(paths x cacheKeys), and one React cascade per
  path over 4,165 sidebar rows.
- **Numbers** at this vault's dimensions (2,452 cached files):

  | changed files | per-file commits | one batched commit |
  | --- | --- | --- |
  | 100 | 42.7 ms | 0.4 ms |
  | 500 | 191.2 ms | 0.5 ms |
  | 1,500 | **576.1 ms** | **0.5 ms** |

- **Fix.** Queue modify-path results, commit once in a `finally` so a late
  failing path cannot discard what earlier paths did. `seen` already guarantees
  one visit per rel, and nothing in the loop reads back the queued values, so
  one commit is equivalent.

## Round 3 — a `git commit` inside the vault rescanned the whole vault, per path

- **Evidence.** The watcher skipped a path only if its BASENAME started with a
  dot, so `.git/index` read as an ordinary file called `index`. It is absent
  from `files` (scanVault never descends into `.git`), `registerExternalFile`
  refuses it, and the fallback then runs `refreshMissingExternalFiles` — a full
  `scanVault`, 4,165 `readDir` + 4,165 `stat` IPC round-trips — for that ONE
  path, and again for the next. Nine representative infrastructure paths
  (`.git/index`, `.git/HEAD`, `.git/refs/…`, `.git/objects/…`,
  `node_modules/…`) triggered **8** whole-vault rescans; `.obsidian/…` was not
  even caught, so it was registered as a vault file `scanVault` would never
  return.
- **Fix.** `isIndexableVaultRelPath` (`vault.ts`) — one definition of what
  belongs in a vault (no segment starting with `.`, none named
  `node_modules`/`.git`), sharing `SKIPPED_DIRS` with `walk` and used by both
  the watcher and `registerExternalFile`. Pinned against a real `scanVault` run
  so the two cannot drift. **8 rescans → 0**, real edits unaffected.
- Also bounded, defensively: `refreshMissingExternalFiles` runs at most once per
  batch, and a path still unresolved after it schedules the debounced refresh
  instead of being dropped (it was dropped before).
- Also removed: the relPath list rebuilt for every event path even though
  `normalizeVaultRelPath` consults it only for an absolute path outside the
  vault root. Built lazily now — **45.5 ms → 0.8 ms** per 1,500-path batch
  (60x), with both call forms proven equivalent across every path shape
  (under-root, aliased root, relative, `file://`, Windows drive-letter, UNC).

## Round 4 — search re-proved the same Unicode fact on every keystroke

- **Evidence.** `canScanRaw` is a full `indexOf` over each file's text, run per
  file per keystroke — but its answer depends only on the TEXT, never on the
  query. It was **13.5 ms of a 66.8 ms pass (20.2%)**, and exactly **2 of 2,452
  files** in this vault contain U+0130 at all.
- **Fix.** `canScanRawFor`, memoized by `relPath` and validated by string
  REFERENCE equality — the cache hands out the same instance until the text
  actually changes, so a stale answer is unreachable and a miss just recomputes.
  `openVault` calls `resetSearchEligibility` alongside `resetVaultTaskMemo`.
- **Numbers** (real vault): cold two-character term **91.1 → 77.7 ms**; typing
  "password" (8 keystrokes) **282.0 → 231.4 ms**.
- **Parity, measured not assumed.** The shipped `searchVault` was run against a
  verbatim copy of the pre-change loop over the whole corpus for **31 queries** —
  case variants, `İstanbul`, `café`, `日本語`, emoji, regex metacharacters,
  Kelvin sign, every `ext:`/`type:`/`.ext` form, quoted phrases — plus
  progressive narrowing across 8 keystrokes: **0 mismatches** in rank, count,
  candidates or snippets.

## Round 5 — `fileFor` scanned the whole vault

- **Evidence.** `get().files.find(...)` over 4,165 files: **11.2 us** a call,
  asked on selection, on every viewer render, and up to three times per path in
  the watcher loop.
- **Fix.** A Map rebuilt only when the `files` array identity changes, keeping
  `find`'s first-match semantics. Sound because every mutation replaces the
  array — the one site that pushes/sorts takes a copy first, which
  `storeIndexContract.test.ts` pins.
- **Numbers.** 4,500 lookups (a bulk-change batch) **34.73 → 0.25 ms** (139x);
  per lookup **11.2 us → 0.02 us**.

## Also fixed: the test harness counted scratch files

`vite.config.ts` excluded `node_modules`, `dist` and `.backups` from the suite
but not `tmp/` — gitignored scratch that this repo's own tooling writes into. A
measurement harness dropped there silently joined `npm test` and moved the
counts a green claim is judged by (observed: 71 files/723 tests reported as
73/732). `tmp/` is now excluded for the same reason as `.backups/`.

## Result

`npm run typecheck` clean · `npm test` **72 files / 753 passed + 1 skipped**
(was 71 / 723; +30, every new contract test confirmed FAILING against the
pre-fix source) · `npm run test:perf` 4/4 · `npm run build` clean, entry gzip
124.40 → **125.08 kB** (+0.68 kB for the guards, memo and index) · `npm audit`
0 · `git diff --check` clean.

Browser demo replayed end to end with **zero console errors**: file switching
resolves the correct file through the new index for every row; `"living map"`
returns Welcome with the right snippet and count; `served from memory` returns
**spark (SVG)** — a non-markdown file matched on CONTENT through the memoized
path; PDF opens and paints 734x950 with no fallback, and Edit → + Page → Undo →
Redo cycles 1 → 2 → 1 → 2 canvases with `Saved`/`Save` tracking correctly.

## Findings recorded but NOT changed

- **Neither save path passes an expected-bytes precondition.** The debounced
  save and `flushSave` both call `writeNote(file, pending)` with two arguments,
  so an external change to the ACTIVE file between load and save is silently
  overwritten. Round 1 removes the systemic source of stale text but
  deliberately leaves the active document alone, which is the long-standing
  behavior ("the doc you are typing in wins"). Making it fail closed needs a
  conflict UX, which is a product decision, not a bug fix.
- **Deep Research is 31.79 kB of the 370.63 kB entry chunk** (8.6%), confirmed
  by decoding the build's sourcemap byte spans rather than from prose. Still
  deferrable in principle, but it has SYNCHRONOUS call sites
  (`RESEARCH_DEPTH_PRESETS` in `openDeepResearch`, `explainResearchTimeout`
  inside the event listener), so splitting it means restructuring the module
  rather than moving an import — and the browser demo cannot complete a native
  Pi research run to verify it. High risk for a startup/size win; not taken.
- **The content cache retains ~110 MB of heap** for 61 M characters on this
  vault. That is the price of full-text coverage; reducing it means an index
  (matching without retaining text, plus on-demand snippets) or dropping
  coverage. Neither is a small change and the first is a real rewrite of the
  parity-verified matcher.
- **Tree virtualization** would remove the remaining 4,165 fibers and 12,352 DOM
  nodes, but changes scroll/keyboard/drag semantics and needs device QA.
- **Vault open performs 2,452 reads and 4,165 stats with unbounded fan-out.**
  Node-side I/O is only ~272 ms total here, so the cost is IPC shape, not disk;
  bounding it was measured as no latency win in the 2026-07-25 pass and cannot
  be re-measured for peak memory without a device trace.
