# Document Architecture

Mesa treats a vault file as immutable identity/metadata plus one of two content
pipelines: text or bytes. `scanVault` produces `VaultFile` records;
`fileKind` is the single renderer dispatch; `DocPane` selects the editable text
surface, read-only code surface, or `MediaView`.

## Format Matrix

| File class | Load/ownership | Render | Mutation/persistence |
| --- | --- | --- | --- |
| Markdown, plain text | `store.ensureContent` → shared text cache | CodeMirror / `MarkdownView` | Debounced `writeNote` → `persistVerifiedBytes` |
| Code, CSV/TSV, JSON, XML, SVG source | shared text cache | `CodeView`; CSV/TSV table; windowed large-file view | Read-only |
| RTF | shared text cache | `rtfToText` → `RtfView` | Read-only |
| Saved HTML | shared text cache + optional sibling reads; detached views read their explicit file | sanitized/hydrated offline `srcDoc`; opaque frame with per-file/session active-content consent | Read-only |
| Images and video | asset URL; bytes do not enter React state | native `img` / `video` | Read-only |
| PDF | dedicated byte load in `usePdfEditor` | pdf.js worker → canvases; verified in-memory native fallback | pdf-lib byte transforms → `persistPdfBytes` → `persistVerifiedBytes` |
| Archives | byte import only | `.zip` is extracted during drop import | each output uses `persistVerifiedBytes` |
| Office, spreadsheet, presentation, CAD, other binary | path/metadata only | generic file card / external window | Read-only / unsupported internally |

The “other” row is not an internal document implementation. Mesa preserves and
lists those files but does not claim to parse, render, or serialize them.

`CodeView` keeps the exact tokenized code view and RFC-style CSV/TSV table for
ordinary files. Very large code and data files use a windowed row view, so file
open and scroll work scales with the viewport instead of total line count.

## Shell subscriptions

The workspace shell subscribes to its layout and narrow lifecycle inputs.
Vault status/loading are read by Welcome and status surfaces; document navigation,
file catalogs and Deep Research progress are read by their owning views.
Research snapshots and Pi context are published through effect-owned store
subscriptions, preserving initial delivery and cleanup without redrawing the shell.
Pi context publishes only when vault, document, tabs or settings inputs change.
`src/App.rerender.test.tsx` checks this boundary and retains a layout-render control.

## Shared Lifecycle

1. `scanVault` discovers files without reading content.
2. `store.selectFile` changes identity immediately. Only
   `isTextualVaultFile` files may enter `contentCache`; binary files never
   round-trip through a JavaScript string. The shared indexed cache keeps
   compressed text with an 8 Mi-character decoded LRU. Non-Markdown hydration
   retains its separate admission limits; decoded eviction preserves compressed
   search coverage. Active editors and unsaved buffers remain outside that LRU.
   See [Vault index](vault-index.md) for the complete memory boundary.
3. `fileKind` and `DocPane` select one renderer. Heavy PDF, Markdown, graph,
   editor, and terminal stacks keep their established lazy-load boundaries.
4. Text edits debounce through `writeNote`; blur/hide/quit uses the same
   `flushableNoteText` gate. A missing cache entry is not an empty document.
5. Every Mesa-authored vault write uses `persistVerifiedBytes` or a stricter
   wrapper. Drop imports and ZIP extraction use the same boundary.
6. The watcher refreshes metadata. A clean open PDF adopts external bytes;
   unsaved edits remain visible and block stale overwrite.

## PDF Lifecycle

1. `MediaView` lazy-loads `PdfView` in the main workspace. A standalone
   document window lazy-loads that same component and passes its selected
   `VaultFile` explicitly; there is no second iframe-only PDF implementation.
   The main renderer sends its file catalog to a detached document window,
   which watches the selected file without a second vault scan.
2. `usePdfEditor` reads exact bytes, snapshots the saved baseline, and gives a
   copied/sanitized buffer to one pdf.js document proxy. It retains the active
   `PDFDocumentLoadingTask` and destroys it when the parse is replaced or the
   viewer unmounts, so stale large-document work does not retain its source and
   transferred buffers.
3. The worker parses; page 1 mounts first and page canvases paint sequentially
   through one scratch canvas. The hook renders only mounted canvases, then the
   view admits the remaining page shells in small batches after page 1 is
   visible. Zoom changes projection/render scale without reparsing bytes.
4. Blank-paint validation first probes a 32×32 grid and, only when that grid
   appears blank, scans the already-read full pixel buffer. This preserves
   sparse valid pages while retaining the broken-render fallback.
5. Edit Text extracts zoom-independent text sources and reprojects them.
   Page-scoped edits re-extract/repaint only accumulated stale pages;
   structural edits and history operations invalidate all pages.
6. Every transform is `Uint8Array → Promise<Uint8Array>`, validated before it
   enters bounded undo/redo history.
7. Save serializes through the edit queue, checks document generation/path,
   validates the on-disk baseline inside the transaction, verifies authored PDF
   bytes, atomically commits, and reads back byte-for-byte. Failed rollback
   preserves the original as a named rescue artifact.

## Browser Regression Surface

Mesa does not ship an example PDF. `PdfView` exposes stable `data-testid` hooks
for the editor, page container, and numbered canvases. Local PDF regression
runs use a synthetic file created outside the repository. The workflow is:

1. Open the local synthetic PDF.
2. Wait for page 1 to have non-zero canvas dimensions and for the warm-start
   iframe to disappear.
3. Enter `Edit PDF`, append a page, and observe two numbered canvases.
4. Undo to one page and `Saved`; redo to two pages and `Save`.
5. Press Save and confirm the result in a disposable vault.
6. Confirm no PDF error/fallback iframe and no new console or worker error.

Local PDF tests pin sparse-paint behavior and stable automation hooks. Desktop
QA remains distinct from browser-demo checks.
Run the same sequence once in the normal workspace and once at the standalone
`?doc=...&vault=...` route: both surfaces must expose the same editor, canvas,
history, fallback, and save behavior.

## Large text input

Markdown metadata extraction scans malformed link labels without repeated
searches of the same region. RTF conversion processes each whitespace run once.
Long unmatched labels and space runs must not freeze document access.

## Text revisions and editor sessions

The store and per-path save coordinator own current text and unsaved revisions.
CodeMirror sessions retain selection, scroll, and undo for unchanged notes only.
Reopening compares the cached document with the exact current store text. A
mismatch creates fresh history; external replacement of the active document
also clears history. Vault identity is part of the session key. Session eviction
cannot discard a draft because drafts remain in the store/save coordinator.

## Incremental Markdown previews

A dedicated worker parses the complete source with one reference environment.
It returns complete top-level Markdown blocks. Lists, tables, nested callouts,
and balanced raw HTML containers remain intact. Ambiguous or malformed raw HTML
uses one document-sized context rather than changing browser parsing semantics.
Each preview admits one active parse and only the newest waiting source; stale
replies never reach the DOM. Worker failure uses the same parser locally.

The DOM controller compares exact rendered block strings, retains unchanged
nodes, and sanitizes only new blocks with the existing DOMPurify policy. Raw
worker output is never inserted directly. A preview-local sanitized cache is
bounded to 256 entries and 1 Mi characters, counting both raw and clean strings.
Changed blocks and obsolete nodes are processed in slices: a 6 ms target, at most
16 changed blocks, or 32 Ki characters of new markup before yielding. Unchanged
blocks do not consume the mutation allowance. New source cancels old scheduled
work; unmount terminates the worker and releases the DOM/cache.

There are no extra block wrappers, so existing CSS, document selection, browser
find, and accessibility retain the complete document. Images resolve when their
nodes are inserted or the vault catalog changes. Wiki clicks remain delegated.
The local `markdown-render` timing mark records reused/sanitized blocks, sanitized
characters, inserted/removed nodes, slices, times and cache size, never content.

Parsing and reconciliation still inspect the document; initial rendering still
creates all its nodes. An indivisible large paragraph, table or HTML context can
exceed the slice target. Worker fallback parses on the UI thread. Highlight
search and catalog-wide image refresh can also inspect the complete preview.
These limits are distinct from replacing and sanitizing all markup on each edit.

Run `npm run test:markdown` for the real worker protocol regression and `npm test`
for DOM, XSS, cancellation, reference and selection tests. The 10,000-block
regression requires a one-block edit to sanitize one block and reuse 9,999.
Visit `/scripts/markdown-acceptance.html` with `npm run dev` for the synthetic
browser fixture, then use Edit one paragraph and Rapid edits. This verifies the
browser pipeline; it is not native macOS or Windows acceptance.

## Application workflow ownership

`store.ts` retains the public Zustand state/action interface and composes typed
controllers. Controllers accept explicit state ports and peer operations;
production imports of store types are erased. They never import its singleton.

| Controller | Responsibility and lifetime |
| --- | --- |
| `controllers/vault.ts` | Vault request/open generations, watcher ownership, external refresh and background indexing. New generations reject stale work; disposal releases pending watchers. |
| `controllers/documents.ts` | Selection, read coalescing, content hydration and bounded peek state. Vault reset clears pending registries; late reads cannot return another vault's text. |
| `controllers/persistence.ts` | Per-path verified saves, save issues, history and recovery. Failed drafts remain dirty; flush gates preserve them across transitions. |
| `controllers/workspace.ts` | Placement and native document/agent/research/panel transfers, singleton checks and readiness acknowledgements. |
| `controllers/research.ts` | One vault-bound research run, context preparation, progress/navigation subscriptions, cancellation, archive and reviewed apply. Cancellation revokes publication before native awaits; partial listener setup rolls back. |

Settings, sync and activity retain their existing domain modules. React consumers
continue using the same store API. Controller tests use injected state ports;
store integration suites verify save, vault-switch, watcher and research behavior
through the assembled application boundary.
