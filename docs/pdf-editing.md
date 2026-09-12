# PDF Editing

Mesa opens PDFs in viewer mode first. Press `Edit PDF` to enable editing tools.
Viewer mode and edit mode now share Mesa's pdf.js canvas renderer, so PDFs that
paint blank inside the system webview still display in Mesa. The native vault
PDF URL remains available as a warm-start/fallback path for files pdf.js cannot
paint reliably.

## Tools

- `Edit text` selects existing rendered text. Click a text run, edit inline, and
  press Enter or blur the field to commit.
- `T` stamps new text.
- Highlight draws a translucent rectangle.
- Pencil records a freehand pointer stroke and persists it into the PDF as ink
  line segments.
- Page controls rotate, move, delete, and append pages.
- Form mode edits fillable PDF fields when the document exposes them.
- `Ctrl/Cmd+Z` undoes the last committed PDF edit while the PDF editor owns
  focus. `Ctrl/Cmd+Shift+Z` and `Ctrl/Cmd+Y` redo. Inline text fields keep their
  normal browser text undo behavior until the edit is committed.

## Text Replacement

Arbitrary PDFs do not provide a reliable universal "modify this original glyph
run" API. Mesa uses a durable visual replacement workflow: it extracts visible
text positions with pdf.js, paints over the selected glyph bounds, and draws the
replacement text with pdf-lib. Undo/redo and Save use the same byte-history path
as all other PDF edits.

Mesa now loads the file bytes and renders pages with pdf.js in both viewer mode
and edit mode. If pdf.js cannot render the current bytes, or if pdf.js
completes but paints a blank first page *that had content to draw*, Mesa falls
back to a native embed fed from the verified in-memory bytes (a blob URL), so
the fallback always shows exactly the document Mesa has open — including
unsaved edits — and cannot diverge from it. Invalid, empty, or mislabeled
`.pdf` files show an explicit error instead of a blank white pane.

A first page that is *genuinely* blank — a blank cover sheet, a separator, a
"this page intentionally left blank" leaf, or a scanned document with an empty
leading sheet — is not a failed render. Mesa asks pdf.js whether the page has
any drawing operations before treating a blank paint as a failure, so these
documents keep Mesa's own canvas renderer and stay fully editable. Previously
they were pushed into the read-only fallback, which silently removed every
editing tool, because the annotation surfaces only exist over Mesa's canvases.

Sparse pages are protected separately. A short title, signature, checkbox, or
small vector mark can fall between every point in a coarse pixel grid even
though pdf.js painted it correctly. Mesa uses the grid only as a fast path; if
it appears blank, Mesa scans the complete pixel buffer already returned by
`getImageData` before consulting the operator list. A valid sparse page
therefore keeps Mesa's canvases and editing tools instead of being mistaken for
a failed render.

Standalone/popout document windows use this same `PdfView` pipeline and pass
their scanned file record into it explicitly. They no longer maintain a
separate iframe-only PDF renderer, so opening a PDF outside the main workspace
does not lose Mesa's canvas fallback checks, edit tools, history, or verified
save path.

Zoom and edit rerenders keep the last painted page visible until the refreshed
page image is ready, so the canvas does not flash white between scales or after
byte updates. Zoom is anchored: pinch (ctrl+wheel) keeps the document point
under the pointer fixed, and the ± toolbar buttons keep the viewport center
fixed. `PdfView.zoomTo` captures the pre-zoom content rect. Pinch samples update
the compositor custom property once per animation frame and stay out of React
until the gesture settles. The debounced pdf.js raster pass then updates the
real canvas dimensions, and the same anchor is applied again after that resize.
Mesa does not ease each wheel event because that makes trackpad input lag behind
the pointer. The zoom range stays clamped to 50–300%. Annotation edits (text, replacement, highlight, and pencil) repaint
only the touched page; structural page edits repaint the document. Large-document
rendering yields between page paints, and text-run extraction only starts when
the `Edit text` tool is active. When several annotations land in quick
succession, every touched page is repainted — the pending repaint set
accumulates rather than being replaced, so an edit is never left invisible
because a later edit on another page overtook it.

Large documents keep the previous visible page pixels during rerenders but use
only one effect-local scratch canvas for the incoming paint, rather than
retaining a second full-resolution canvas for every page. First meaningful page
paint is prioritized: `PdfView` mounts page 1 first, the hook renders only
mounted canvases, and the remaining page shells mount in small batches after
page 1 is visible. This is a scheduling/UI responsiveness change only; the
rendered document still comes from the same byte-backed pdf.js proxy, and
editing/saving still waits on Mesa's verified byte path. Page completion stays
out of React state except for the first-page handoff from the native warm-start
surface. Edit Text indexes extracted runs by page once, so hit-box rendering is
linear in the extracted runs instead of rescanning the whole document for every
page. Hover thumbnails retain the 24 most recently used decoded canvases and
skip stale queued prewarms when the pointer has already moved to another PDF.

## Encrypted PDFs

Encrypted (password-protected) PDFs are strictly read-only. pdf.js can decrypt
and display documents with an empty user password (a common "protected but
viewable" case), but Mesa's editing core (pdf-lib) cannot decrypt at all —
re-serializing an encrypted document produces unreadable output that even
post-save validation cannot distinguish from a healthy file. Every editing
tool therefore fails closed on an encrypted document with a clear
"Mesa keeps it read-only" message before any bytes are touched. Viewing,
zooming, and page geometry are unaffected.

## Pipeline Research

Mesa keeps the byte-backed `pdfjs-dist` path. Mozilla's PDF.js viewer uses the
same core idea needed here: CSS-only zoom for immediate interaction, bounded
page rendering, and a later repaint at the settled scale. Its official viewer
and display-layer examples are the reference implementation:

- [Mozilla PDF.js](https://github.com/mozilla/pdf.js) — Apache-2.0, actively
  maintained, and already used by Mesa for parsing and rasterization.
- [PDF.js page view](https://github.com/mozilla/pdf.js/blob/master/web/pdf_page_view.js)
  — keeps the page view alive while CSS transforms cover scale changes, then
  renders again through the viewer's queue.
- [React PDF](https://github.com/wojtekmaj/react-pdf) — a useful React binding,
  but it does not replace PDF.js scheduling and would add an abstraction Mesa
  does not need.
- [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) — technically strong
  WebAssembly rendering and editing, but AGPL/commercial licensing and manual
  WebAssembly lifetime management make it unsuitable for Mesa's MIT,
  local-first frontend pipeline.

No new PDF dependency is needed. The adopted change is the PDF.js pattern that
fits Mesa's existing exact-byte authority: frame-coalesced compositor preview,
mounted-page rendering, stale-work cancellation, and final raster
re-anchoring.

## What Mesa Renders, and When

Mesa rasterizes the pages you are looking at, not the whole document. Page 1 is
painted as soon as the document parses; the pages around your scroll position
are painted just ahead of you; and pages you have scrolled well away from hand
their pixel memory back. Scrolling back repaints them rather than trusting a
canvas whose bitmap was released, so a page is either correct or being drawn —
never stale.

This is what makes long documents usable. Measured on a 748-page Army field
manual (20 MiB) and a 357-page one (8.7 MiB), against the previous
paint-everything behaviour:

| | 357-page manual | 748-page manual |
| --- | --- | --- |
| Time to first page | 308 ms → **237 ms** | 2,705 ms → **248 ms** |
| Pages rasterized on open | 714 → **4** | 12,308 planned → **4** |
| Canvas memory | 964 MB → **13 MB** | ~2 GB (never completed) → **5 MB** |
| Main-thread long tasks | 509 ms → **0 ms** | — → **0 ms** |

Page geometry does not depend on painting: every page is measured once (page
size only, no rasterization) so the scroll bar is honest immediately and pages
do not shift under you as they paint.

## Opening a PDF When Memory Is Tight

Two things dominate an open on a machine that is already swapping, and neither
shows up on an idle one.

The webview's own PDF renderer used to be started for every open, to cover the
gap before Mesa's first page appeared. That is a second full PDF stack over the
same file: the OS renderer reads and maps the document again, alongside the
copy Mesa holds and the copy inside the pdf.js worker. Mesa now waits 120 ms
first, so for ordinary documents — which reach their first page well inside
that — the duplicate is never started at all. A genuinely slow open still gets
the cover, unchanged.

Opening an N-byte PDF also used to allocate 3N: the read, a defensive copy of
it, and the copy pdf.js transfers into its worker. The middle copy bought
nothing — the buffer comes straight off disk and nothing else refers to it — so
Mesa adopts it instead. Bytes that arrive from anywhere less certain (edit
results, save round-trips) are still copied.

Saving likewise keeps exactly one immutable snapshot of the edited bytes. The
opened baseline is already immutable and is passed directly to the verified
writer as its stale-on-disk precondition; after a successful validated write,
the save snapshot becomes the next baseline. This removes two whole-document
copies without weakening conflict detection or rollback.

Each PDF viewer keeps one pdf.js worker and reuses it for the documents you
open in it. Booting a worker means fetching and compiling about 1.4 MB of
JavaScript on a new thread — measured at 145 ms the first time in a session and
around 46 ms after that — and it was the entire "parsing" phase for a small
PDF; reusing one drops it to 1-5 ms, so switching from one PDF to another is
near-instant. The worker is per-viewer rather than shared globally so that one
malformed document cannot affect a PDF open in another window, and a failed
parse throws its worker away so the next document starts from a clean one.
When a PDF is replaced or the viewer closes during parsing, Mesa destroys the
active loading task. A cancellation flag alone would let stale parsing retain
large source and worker-transfer buffers until the parse finished.

That still left the boot sitting in the middle of an open, because the worker
was only built once the file's bytes had been read — 145 ms of the 286 ms it
took to show page 1 of an 11 kB document. Two changes remove it. The worker is
now claimed when the read *starts*, so on a large file the boot runs alongside
it rather than after it. And Mesa keeps one spare worker warm, started when you
hover a PDF or leave one, so the open usually adopts a worker that is already
running and pays nothing at all. Leaving a PDF and coming back to it went from
about 75 ms to about 28 ms to first page.

The spare is always a brand-new worker that has never been given a document, so
handing it to a viewer is the same thing as building one there — just earlier.
A worker that *has* opened a document is never recycled: it is destroyed with
its viewer, and a fresh spare is started for the next open. Mesa does not warm
a worker at startup, only once you have actually touched a PDF, so a vault you
never open a PDF in never pays for one. At most three workers exist at a time:
the one your viewer is using, one for hover thumbnails, and one spare. The
unused spare expires after an idle minute, so a brief return to PDF stays fast
without keeping that extra thread for the rest of the session.

Hover thumbnails share a single worker of their own, rather than starting and
throwing one away per preview — that was seven worker starts for six thumbnails
when sweeping down a folder. Only the latest queued thumbnail remains admitted;
stale queued thumbnail requests settle immediately instead of waiting behind
the active render. It is deliberately separate from the worker your open
document is using, so a file that breaks thumbnailing cannot disturb what you
are reading.

Failed thumbnail loads release their document state before Mesa retries with
file bytes or starts the next preview. This also applies when the retry finds
an HTML error page saved as a PDF. If cleanup itself fails, Mesa replaces the
thumbnail worker before reusing it; an already-rendered preview stays visible.

Files that are not PDFs at all get the same treatment in the viewer. A vault
collects surprisingly many of them — an HTML "not found" page saved with a
`.pdf` name, a download that produced an empty file. Measured on a real vault,
**880 of 1,629 `.pdf` files were not PDFs**, 872 of them byte-identical copies
of one saved error page, so opening one is a routine event rather than an odd
case. Mesa checks the bytes for a `%PDF` header before pdf.js is involved and
explains what the file actually looks like. Because pdf.js never saw those
bytes, the worker Mesa had warmed is untouched and is kept instead of thrown
away: the next real PDF you open still gets a warm worker. Before this, every
one of those files reset the warm-worker state and made the following open pay
a full boot — measured on that vault as a parse stage of 41 ms instead of
3.5 ms and a first page at 170 ms instead of 121 ms. The failure notice also
replaces the "Loading PDF..." line rather than appearing underneath it.

## Undo Depth on Large Documents

Edit, undo, and redo each copy their source bytes before validation. The editor
then adopts that isolated snapshot without another full-document copy. External
transform results and retained history cannot mutate the current document.

Undo and redo hold whole-document snapshots, because a PDF edit is a
byte-in/byte-out transform. Mesa bounds what those stacks retain (128 MiB of
snapshots, 200 entries) and drops the oldest entries first, so editing stays
possible on documents that would otherwise exhaust the webview: measured on the
test corpus, ten highlight edits on a 52 MiB PDF retained 625.6 MiB and kept
growing linearly. Ordinary documents are unaffected — a 36 KiB PDF and a
2.4 MiB scanned PDF both keep their full history — and the most recent
snapshot is never dropped, so one undo always works even on a document larger
than the entire budget.

## Text Mesa Can Write

Mesa stamps text with pdf-lib's built-in standard fonts, whose WinAnsi encoding
covers Latin-1: ASCII, accented Latin letters, the curly quotes / dashes /
ellipsis / bullet / euro block, and the tab and newline characters pdf-lib
normalizes for layout. Greek, Cyrillic, CJK, emoji, and symbols such as `→` are
outside that encoding.

Adding text, replacing text, or filling a form field with characters the fonts
cannot render is refused before the document is touched, naming the offending
characters (`"α" (U+03B1)`) instead of surfacing pdf-lib's raw
`WinAnsi cannot encode "α" (0x03b1)`. The check asks the font itself what it
accepts, so it can never disagree with the encoder or reject text that used to
work. Documents that merely *contain* such text stay fully viewable and
editable — pdf-lib only regenerates the appearance of fields an edit changes,
so filling an ASCII field in a form that holds Cyrillic elsewhere works
normally.

## Page Moves Preserve the Rest of the Document

Moving or reordering pages re-attaches the existing page objects inside the
same document. Form fields (the AcroForm), title/author metadata, outlines,
and named destinations survive page moves unchanged. No-op page operations
(moving a page onto itself, deleting the only page, out-of-range moves) return
the original bytes untouched instead of re-serializing the document, so they
never register as phantom edits.

Edits, undo/redo, and Save are serialized through one PDF byte queue. Each edit
runs against the latest committed bytes, not a stale snapshot captured when the
button was clicked. Mesa validates candidate bytes with a `%PDF-` header check,
`%%EOF` marker check, and pdf-lib parse before accepting them into history or
writing them. Desktop saves run through the same verified-overwrite path Mesa
uses for all personal vault files: write and verify a sibling backup, write and
verify (and PDF-validate) temporary bytes, atomically rename the verified temp
over the real PDF path, and read it back byte-for-byte. If the final file comes
back truncated, invalid, or mismatched, Mesa restores the backup instead of
leaving a corrupted PDF behind. See `docs/vault-safety.md` for the full write,
crash-recovery, and stale-overwrite contract.

Every queued operation is also bound to the PDF path and document generation
that started it. `PdfView` is reused when navigating directly from one PDF to
another; if an edit, undo, redo, or validation from the previous PDF finishes
late, its result is discarded instead of entering the newly selected
document's state. Save captures the document identity and path before it enters
the queue, then captures the current bytes and on-disk baseline after earlier
queued edits settle. It therefore saves prior accepted edits without ever
combining one PDF's bytes with another PDF's path.

If another tool rewrites the PDF while it is open in Mesa: a clean document
reloads automatically (with a status note); a document with unsaved edits keeps
the edits visible and blocks Save until the file is reopened, so Mesa never
silently overwrites the newer on-disk version and never discards the edits.

Pencil input records every pointer point, including events arriving faster than
the display refresh rate. Mesa only coalesces publication of the on-screen draft
to one update per animation frame; the committed ink annotation still receives
the complete point sequence. PDF render planning likewise considers the mounted
canvas shells directly, so a corrupt or extreme declared page count cannot
create a matching temporary JavaScript array before the viewport filter runs.

## Browser Regression

The browser demo includes a deterministic local `Mesa PDF Tour.pdf`. It exists
for the living PDF regression workflow and never phones home or writes a real
vault. Open it, wait for the first canvas to replace the warm-start iframe,
enter Edit PDF, append a page, undo, redo, and press Save. The expected final
state is two rendered page canvases, no fallback iframe/error, and
`Editing is read-only in the browser demo.` with no new console/worker errors.
The fixture bytes and stable automation hooks are pinned by the PDF/vault tests.
Replay the sequence in both the main workspace and the standalone document
route. Desktop save/reopen validation remains a separate native check.
