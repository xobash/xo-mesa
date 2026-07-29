# Document Architecture

Mesa treats a vault file as immutable identity/metadata plus one of two content
pipelines: text or bytes. `scanVault` produces `VaultFile` records;
`fileKind` is the single renderer dispatch; `DocPane` selects the editable text
surface, read-only code surface, or `MediaView`.

## Format Matrix

| File class | Load/ownership | Render | Mutation/persistence |
| --- | --- | --- | --- |
| Markdown, plain text | `store.ensureContent` → shared text cache | CodeMirror / `MarkdownView` | Debounced `writeNote` → `persistVerifiedBytes` |
| Code, CSV/TSV, JSON, XML, SVG source | shared text cache | `CodeView`; CSV/TSV table | Read-only |
| RTF | shared text cache | `rtfToText` → `RtfView` | Read-only |
| Saved HTML | shared text cache + optional sibling reads | direct local iframe; rewritten/hydrated `srcDoc` fallback | Read-only |
| Images and video | asset URL; bytes do not enter React state | native `img` / `video` | Read-only |
| PDF | dedicated byte load in `usePdfEditor` | pdf.js worker → canvases; verified in-memory native fallback | pdf-lib byte transforms → `persistPdfBytes` → `persistVerifiedBytes` |
| Archives | byte import only | `.zip` is extracted during drop import | each output uses `persistVerifiedBytes` |
| Office, spreadsheet, presentation, CAD, other binary | path/metadata only | generic file card / external window | Read-only / unsupported internally |

The “other” row is not an internal document implementation. Mesa preserves and
lists those files but does not claim to parse, render, or serialize them.

## Shared Lifecycle

1. `scanVault` discovers files without reading content.
2. `store.selectFile` changes identity immediately. Only
   `isTextualVaultFile` files may enter `contentCache`; binary files never
   round-trip through a JavaScript string.
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
   document window lazy-loads that same component and passes its scanned
   `VaultFile` explicitly; there is no second iframe-only PDF implementation.
2. `usePdfEditor` reads exact bytes, snapshots the saved baseline, and gives a
   copied/sanitized buffer to one pdf.js document proxy.
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

The browser demo includes `Mesa PDF Tour.pdf`, a deterministic local one-page
PDF. `PdfView` exposes stable `data-testid` hooks for the editor, page
container, and numbered canvases. `scripts/pdf-perf-browser.mjs` can collect
the in-viewer PDF timeline, long tasks, canvas count, and Chromium heap sample
when run with a local Playwright installation. The replayable workflow is:

1. Open `Mesa PDF Tour.pdf`.
2. Wait for page 1 to have non-zero canvas dimensions and for the warm-start
   iframe to disappear.
3. Enter `Edit PDF`, append a page, and observe two numbered canvases.
4. Undo to one page and `Saved`; redo to two pages and `Save`.
5. Press Save and confirm the browser-demo read-only status.
6. Confirm no PDF error/fallback iframe and no new console or worker error.

`vault.test.ts`, `pdf.test.ts`, and `pdfBytes.test.ts` pin the fixture bytes,
sparse-paint behavior, and stable automation hooks. Desktop QA remains distinct
because browser-demo Save intentionally never writes a personal vault file.
Run the same sequence once in the normal workspace and once at the standalone
`?doc=...&vault=...` route: both surfaces must expose the same editor, canvas,
history, fallback, and save behavior.
