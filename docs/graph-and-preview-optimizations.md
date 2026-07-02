# Graph view + preview/editor latency optimizations (2026-07-01)

Rollback: pre-change copies of every touched graph/preview file are in
`.backups/graph-view-2026-07-01/`. Copy any file back over `src/` to revert.

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
