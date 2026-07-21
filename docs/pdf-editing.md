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
completes but paints a blank first page, Mesa falls back to a native embed fed
from the verified in-memory bytes (a blob URL), so the fallback always shows
exactly the document Mesa has open — including unsaved edits — and cannot
diverge from it. Invalid, empty, or mislabeled `.pdf` files show an explicit
error instead of a blank white pane.

Zoom and edit rerenders keep the last painted page visible until the refreshed
page image is ready, so the canvas does not flash white between scales or after
byte updates. Zoom is anchored: pinch (ctrl+wheel) keeps the document point
under the pointer fixed, and the ± toolbar buttons keep the viewport center
fixed. `PdfView.zoomTo` captures the pre-zoom content rect, and a layout effect
re-measures after the scale commit — the forced synchronous layout there reads
the final post-zoom geometry before the 140 ms transform transition starts, so
the scroll correction targets the settled state exactly and the ease animates on
top of it. The zoom range stays clamped to 50–300%. Annotation edits (text, replacement, highlight, and pencil) repaint
only the touched page; structural page edits repaint the document. Large-document
rendering yields between page paints, and text-run extraction only starts when
the `Edit text` tool is active.

## Encrypted PDFs

Encrypted (password-protected) PDFs are strictly read-only. pdf.js can decrypt
and display documents with an empty user password (a common "protected but
viewable" case), but Mesa's editing core (pdf-lib) cannot decrypt at all —
re-serializing an encrypted document produces unreadable output that even
post-save validation cannot distinguish from a healthy file. Every editing
tool therefore fails closed on an encrypted document with a clear
"Mesa keeps it read-only" message before any bytes are touched. Viewing,
zooming, and page geometry are unaffected.

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

If another tool rewrites the PDF while it is open in Mesa: a clean document
reloads automatically (with a status note); a document with unsaved edits keeps
the edits visible and blocks Save until the file is reopened, so Mesa never
silently overwrites the newer on-disk version and never discards the edits.
