# Document Architecture

Mesa treats a vault file as immutable identity/metadata plus one of two content
pipelines: text or bytes. `scanVault` produces `VaultFile` records;
`fileKind` is the single renderer dispatch (`documentKind` adds files sniffed
as text when opened); `DocPane` selects the editable text surface or
`MediaView`.

## Format Matrix

| File class | Load/ownership | Render | Mutation/persistence |
| --- | --- | --- | --- |
| Markdown, plain text | `store.ensureContent` → shared text cache | CodeMirror / `MarkdownView` | Debounced `writeNote` → `persistVerifiedBytes` |
| Code, config, JSON, YAML, XML, logs, SVG source | shared text cache | CodeMirror with token highlighting | Same as Markdown |
| CSV/TSV | shared text cache | Editable windowed table (`TableEditor`) with a Raw toggle | Same as Markdown; only edited rows are re-serialized |
| Unknown extension that sniffs as text | shared text cache after the open-time sniff | CodeMirror, plain text | Same as Markdown |
| RTF | exact bytes in `useRtfEditor` (search uses the shared text cache) | `rtfDocument.ts` model → `RtfView` paragraphs and format runs | Main pane: edited runs only (`rtfEdit.ts`) → `saveDocumentBytes` → `persistVerifiedBytes`; previews read-only |
| Saved HTML | shared text cache + optional sibling reads; detached views read their explicit file | sanitized/hydrated offline `srcDoc`; opaque frame with per-file/session active-content consent | Read-only |
| Images | asset URL for viewing; exact bytes only while the editor is open | native `img`; `ImageEditor` canvas | PNG/JPEG/WebP: confirmed re-encode → `saveDocumentBytes`, or Save as copy to a new file |
| Video and audio | asset URL; bytes do not enter React state | native `video` / `audio` (`MediaPlayer.tsx`) | Read-only |
| PDF | dedicated byte load in `usePdfEditor` | pdf.js worker → canvases; verified in-memory native fallback | pdf-lib byte transforms → `persistPdfBytes` → `persistVerifiedBytes` |
| Archives | drop import; viewer reads the end record, directory and one entry by range | `.zip` is extracted only during drop import; the viewer lists contents and previews entries | import outputs use `persistVerifiedBytes`; the viewer never writes |
| EPUB | viewer reads only the entries a step needs, by range | spine-ordered chapters in the sanitized empty-sandbox frame | Read-only |
| PowerPoint `.pptx`, `.ppsx`, `.pptm` | exact bytes in `usePresentationEditor`; OOXML package layer (`lib/ooxml/`) | `lib/pptx/` slide model → positioned HTML (`PresentationView`, `PresentationSlide`); thumbnails, notes | Main pane, after Edit: text, notes, slide order, delete, duplicate as part patches → re-opened and checked → `saveDocumentBytes`, or Save as copy; `.pptm` and signed files read-only ([Office editing](office-editing.md)) |
| Word (`.docx`, `.docm`, `.dotx`, `.dotm`) | exact bytes in `useWordDocument`; package opened by `lib/ooxml` | lazy layout engine (`wordEngine.ts`), locked for viewing until Edit | Main pane: changed parts only onto the original package (`planWordSave`), checked, then `saveDocumentBytes`; Save as copy; detached windows read-only ([Office editing](office-editing.md)) |
| Excel workbooks (`.xlsx`, `.xlsm`, `.xltx`, `.xltm`) | exact bytes in `useXlsxEditor`; a module worker opens, indexes and writes | `SpreadsheetView`: sheet tabs, windowed `DataGrid`, formula bar | Main pane, after Edit: changed cells patched into the original sheet XML (`lib/ooxml/`) → verified in the worker → `saveDocumentBytes`, or Save as copy; previews read-only |
| OpenDocument `.odt`, `.ods`, `.odp` (templates read-only) | exact bytes in `useOdfEditor`; OOXML ZIP container, `lib/odf/` | `OpenDocumentView`: text page, `DataGrid` sheets, `PresentationSlide` slides | Main pane, after Edit: `content.xml` splices only → re-opened and checked → `saveDocumentBytes`, or Save as copy; detached windows read-only ([Office editing](office-editing.md)) |
| Legacy Office `.doc`, `.xls`, `.ppt` and their templates | the whole file through the bounded range reader (at most 64 MiB) | `FileFallbackView` **Content** tab: `LegacyOfficeView` reads text, cells and slides (`lib/legacyOffice/`) | Never written; an editable `.docx`/`.xlsx`/`.pptx` copy can be made ([Office editing](office-editing.md#legacy-binary-office-files)) |
| `.xlsb`, flat OpenDocument, CAD, other binary | range reads: 64 KiB head, then 1 MiB windows at any offset | `FileFallbackView`: details, type from magic bytes, hex; ZIP-based packages also list contents | Read-only / unsupported internally |

Password-protected `.docx`, `.xlsx` and `.pptx` files open in their format's
row through `EncryptedOfficeGate`
([Office editing](office-editing.md#password-protected-files)).

The last row is not an internal document implementation. Mesa preserves and
lists those files but does not claim to parse, render, or serialize them.

## Fallback viewer

Every file without a dedicated viewer opens in `FileFallbackView`, never an
empty card. It shows the name, size, modified time, vault location and the
type detected from the first bytes (`lib/fileSniff.ts`, the one detector; PDF
errors use it too). When the name and the bytes disagree, such as a `.docx`
that is really a saved HTML page, it says so. Legacy Office files (OLE compound
files) say how to make them editable: save as `.docx`, `.xlsx` or `.pptx`.
Password-protected legacy files and OpenDocument files say they are
read-only and why; password-protected `.docx`, `.xlsx` and `.pptx` files open
with their password ([Office editing](office-editing.md#password-protected-files)).
A Word file the Word view cannot open shows here with the view's reason. Actions: switch view, open in a
new window, and show the active file in the sidebar.

- **Bytes**: a windowed offset / hex / ASCII view (`lib/hexView.ts`) over a
  file of any size. Only on-screen rows render. Bytes come from the native
  range read (`vault_read_range`: ≤ 1 MiB from any offset, with the file's
  size and modification time). The view asks for one 1 MiB window after
  scrolling settles (120 ms), never per row, and keeps at most eight windows
  (8 MiB), least recently used first out. A read that sees a new size or
  modification time drops every cached window, shows that the file changed on
  disk and continues with the current version; a reply to a read issued
  before the change is dropped. The scroll spacer is capped and maps position
  proportionally, so multi-GB files scroll end to end.
- **Contents** (any ZIP-based file): path, size, compressed size and date from
  the central directory (`lib/zipView.ts`, sharing the `zipCodec` end-record
  and directory parsers with import). Listing reads only the last 64 KiB (end
  record) and at most 16 MiB of central directory, so archive size is not
  limited. At most 10,000 rows are listed; ZIP64 is refused. Traversal,
  absolute, drive-letter and symbolic-link names are listed with a warning and
  never extracted. Selecting an entry decodes only that entry, in memory:
  declared size ≤ 1 MiB, compressed size at most slightly above it, stored or
  deflate only, no encryption, data inside the archive. Only that entry's local
  header and data are read. Deflate input is fed in 4 KiB steps into a fixed output buffer, and
  output beyond the declared size is refused as a possible ZIP bomb. Text
  shows read-only; other entries open in the same hex view.
- **Read book** (EPUB): `lib/epub.ts` follows `container.xml` to the package,
  reads spine order (non-linear items skipped), metadata and the EPUB 3 nav
  or EPUB 2 NCX contents list, iteratively and within fixed limits. Each
  chapter keeps only package stylesheets, images and fonts, inlined as data
  URLs (8 MiB each, 32 MiB per chapter); every other URL attribute and CSS
  `url()` is removed. The markup then passes through `savedHtmlFrameDocument`
  and renders in a `sandbox=""` srcDoc frame: no scripts, network, remote
  frames or IPC. Links inside the book do not navigate; use the contents list
  or Previous and Next. Opening reads the directory, container, package and
  contents list; a chapter reads its text, stylesheets, images and fonts
  (at most 48 MiB of entries, six read-then-parse rounds).

Archives and books are never read whole. Every read goes through
`lib/byteSource.ts`: a `ByteSource` is pinned to the size and modification
time seen when it opened, splits reads into 1 MiB native calls, and refuses
with "This file changed on disk" when a later slice comes from another
version, so one parse never mixes versions. The browser demo slices its
in-memory file (at most 8 MiB) the same way.
`FileFallbackView`, `ZipView` and `EpubView` are lazy chunks; fflate and the
HTML purifier load only when used. Tests: `fileSniff.test.ts`,
`hexView.test.ts`, `vaultByteRead.test.ts`, `zipView.test.ts`, `epub.test.ts`,
`MediaView.test.tsx`; Rust `vaultrange_tests.rs`.

Main and detached image viewers and hover/search previews use `VaultImage`.
It preserves the approved-vault asset URL and lets the system webview decode
the image. A load or decode failure replaces the broken-image icon with a
message and Retry image action. Opening another image clears that failure;
retry creates a fresh image element. Mesa does not rewrite damaged images.
`MediaView.test.tsx` covers load failure, retry and document-switch isolation.

## Text files

Every text file opens in the main-pane editor and saves through the same
debounced, verified path as notes. Encoding, BOM, line endings and the final
newline are kept: untouched lines keep their break (`lib/lineEndings.ts`) and
`writeNote` keeps a disk BOM. Opening a file without editing it writes nothing.

- Highlighting: prose (`.md`, `.markdown`, `.txt`, `.text`) uses the Markdown
  language with Live preview and Outline. Other text files use an incremental
  CodeMirror stream language driven by the token rules in `lib/highlight.ts`
  (`components/editorSyntax.ts`), so a block comment spans lines and only the
  viewport is parsed.
- Read-only, always with the reason on screen: invalid UTF-8 (saving could
  corrupt it), a failed or over-limit read until Retry or Load file anyway, and
  text above 16 Mi characters. Each keystroke serializes the whole document for
  the save path; measured 3.5 ms at 16 MiB and 15 ms at 32 MiB (Node, macOS).
- Unknown extensions (`.tex`, `.org`, `.lua`, `.gitignore`, no extension) are
  sniffed once at open: the first 8 KiB must be valid UTF-8 with no NUL byte.
  A text result is remembered for the session (bounded, follows renames) and
  makes the file readable and savable as text; anything else goes to the
  binary view. A failed sniff names the file in the status bar. Vault-scale
  rules (index, search, graph, counts) never sniff.
- CSV/TSV open as an editable table. The delimiter (comma, semicolon, tab or
  pipe) is the one that splits the first 20 rows of the first 16 KiB most
  consistently, respecting quotes; ties keep the extension's default, and
  edits keep the file's delimiter. Select a cell, then Enter, F2 or a
  double-click edits; Enter or Tab commits, Escape cancels, Shift+Enter adds a
  line break in the cell. Add or delete rows and columns, and Undo (50 steps).
  `lib/delimitedTable.ts` indexes rows in one pass and keeps each untouched
  row's exact source text and break; an edited row is re-serialized with RFC
  4180 quoting, new rows take the dominant break, and the final-newline shape
  is kept. Rows are windowed. Above 8 Mi characters the table is view-only
  (a cell commit measured 24 ms at 8 MiB, 150 ms at 32 MiB); Raw still edits.
- `CodeView` remains the read-only view for the idle side of a split and the
  browser popout; very large files use its windowed row view.

## RTF editing

`parseRtfDocument` reads the file's bytes one byte per character and records
every visible character, paragraph break and embedded object with the source
span that produced it. Everything else is skeleton: header groups (`fonttbl`,
`colortbl`, `stylesheet`, `info`), unknown control words and destinations.
Pictures, objects, fields, footnotes and list markers are non-editable
objects; deleting one removes its whole group.

A save compares the edited content with the opened content and keeps the
common prefix and suffix. In the changed region it removes only the spans of
removed characters, breaks and objects; all other tokens stay. New text goes
in as one braced group per format run with explicit `\b`, `\i`, `\ul`,
`\strike`, `\fs`, `\f`, `\cf`, `\cb`, `\highlight` and `\super`/`\sub`
relative to the state at the insertion point; non-ASCII text is written as
`\uN?` with `\uc1`. The result is parsed again and must reproduce the edited
content exactly, or nothing is written. An unchanged document writes nothing.
The save precondition is the opened bytes.

Read-only with a stated reason: tables, section/page/column breaks, `\bin`
in the body, raw 8-bit text, `\'xx` escapes under a code page other than
1252 or a font charset other than 0/1, unbalanced groups, files over 8 MiB.
Editing happens only in the main pane, where the store's unsaved-edit guard
(`setBinaryDirty`) protects navigation, close and vault actions. A file that
changes on disk while edited keeps the edits and blocks Save; Discard
(confirmed) loads the disk version. `rtfEdit.test.ts` holds byte-exact
round-trip fixtures in TextEdit, Word and WordPad style.

## Image editing

`Edit image` opens `ImageEditor` (lazy) for PNG, JPEG and WebP. Rotate, flip,
crop and resize are an operation list composed into one affine matrix
(`imageEditOps.ts`) and drawn once from the original pixels, so undo is
exact and steps never compound quality loss. `imageInspect.ts` reads only
headers and refuses SVG, GIF, HEIC and other formats, animated PNG/WebP,
contents that do not match the extension, and images over 40 megapixels or
16,384 pixels a side (each full-size RGBA buffer is 4 bytes per pixel and
an edit holds up to three).

Save overwrites only after `confirmAction` names the cost: JPEG/WebP quality
loss, every metadata kind found (EXIF, ICC, XMP, text) and 16-bit depth
reduction. The encoder must return the requested type and size, else the
save is refused. Save as copy writes `<name> copy.<ext>` with a
missing-file precondition (PNG when the system cannot encode the original
format). Unsaved operations use the same unsaved-edit guard as PDFs.

## Spreadsheet editing

An `.xlsx`, `.xlsm`, `.xltx` or `.xltm` file opens in `SpreadsheetView`
(lazy). A module worker (`xlsx.worker.ts`) checks and inflates the package,
runs the capability gate and indexes the first visible sheet, so a large
workbook does not block the interface. The view shows sheet tabs, cell values
(shared and inline strings, numbers, booleans, errors and dates through
their number format), bold, italic, underline, strike, explicit RGB font and
fill colours, alignment, merged cells, frozen rows and columns, and column
widths. The formula bar shows a formula cell's formula, including a shared
formula filled from its anchor. Mesa never calculates: a formula cell shows
the result saved in the file, and the view says so.

The file is read-only until Edit. Edit asks first when the capability gate
warns (macros, charts, pivot tables, external links, embedded objects, data
connections) and is disabled with the reason when it refuses (digital
signature, shared-workbook revision log, Strict Open XML). Edits are a draft
over the opened package with undo and redo; dirty state uses the same unsaved
edit guard as PDFs. Save plans the part changes, the worker writes them and
re-opens the result (`verifyXlsxBytes`), and the verified bytes go through
`saveDocumentBytes` with the opened bytes as precondition. A no-op save writes
nothing. A change on disk while dirty keeps the edits and blocks Save; Save as
copy writes `<name> copy.<ext>` as a new file, like the other editors. Details and the refusal
list: [Office editing](office-editing.md).

`.xls` and `.xlsb` open in `FileFallbackView` with the reason and a
suggestion to save a copy as `.xlsx`; flat `.fods` with a suggestion to save
it as `.ods`.

## Audio and video

Audio (`mp3`, `wav`, `m4a`, `aac`, `flac`, `oga`, `opus`) plays in a native
`audio` element. `.ogg` stays on the `video` element, which also plays
audio-only Ogg; when metadata reports no picture, the player switches to
the compact audio layout without reloading. A media error replaces the
player with a reason (unreadable, undecodable, or unsupported by the
system's player) instead of a dead control. Codec support is the system
webview's.

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
   `isOpenableTextFile` files may enter `contentCache`; binary files never
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

## Standalone document windows

Graph node clicks open a decorated native document window. Its only header
and close control is the OS title bar. The title uses the file name without its
extension, independent of frontmatter, and follows wikilinks in the same window.
Dragging that title bar over the main Mesa window docks the current file.

`DocumentView` retains the native close guard: unsaved PDF edits keep the window
open and show a Close stopped alert until Save succeeds. Shared window capability
permissions explicitly grant close, destroy and set-title; Tauri's JS
close-request listener calls destroy after the guard admits a request.
`nativeWindowConfig.test.ts` pins those grants and `doc-*` coverage;
`DocumentView.test.tsx` checks titles, docking cleanup and PDF refusal/retry.
Actual OS close and drag behavior still require native interaction checks.

The browser fallback retains its modal Close button. Other torn-out panel
headers keep their existing controls.

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
