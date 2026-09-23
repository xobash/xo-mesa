# PDF: What's Worth Taking From Stirling (and What Isn't)

Scope frame: Mesa is a note vault that needs **great PDF viewing and editing**, not a
dedicated PDF suite. This assessment picks only the things that raise PDF quality
without dragging in a runtime, a background service, or "Acrobat clone" scope.

## TL;DR

- You can't lift Stirling's code. It's a **Java / Spring Boot** app on Apache PDFBox;
  Mesa is TypeScript running `pdf.js` + `pdf-lib` in the Tauri webview. Nothing
  copy-pastes across. What's portable is a handful of *approaches*, not source.
- **Redaction, watermarking, page numbering** are worth doing — pure TS in Mesa's
  existing stack, zero new dependencies. Redaction is the single highest-value idea
  to borrow from Stirling.
- **OCR** is only worth it via `tesseract.js` (WASM, in-webview). Do it *only* if
  searchable scans are a real need — it's optional, not core.
- **Office conversion (Word/Excel/PPT)** should be **skipped**. There is no in-webview
  path; it means bundling or shelling out to LibreOffice (~hundreds of MB). That is
  exactly the scope creep to avoid.
- **True "embedded text editing"** of arbitrary PDFs is unsolved — *even in Stirling*.
  Mesa's current paint-over-and-redraw approach is the honest state of the art. It can
  be made to *feel* much better, but don't promise reflowable editing.

## The one real constraint

Mesa's PDF layer is entirely client-side: `pdf.js` renders pages to canvas, `pdf-lib`
rewrites bytes, and Mesa already has rotate / delete / reorder / append pages, add &
replace text, highlight, ink, form-field fill, byte-history undo/redo, and a verified
atomic save. That's a solid base.

Stirling's value lives in features that are either (a) simple PDF-engine operations —
portable as concepts — or (b) orchestration of external binaries (Tesseract, LibreOffice,
Ghostscript, qpdf). Category (b) is not "code to port"; it's "install 1.5GB of tools."
Mesa should stay out of category (b) except where a WASM equivalent exists.

License note: Stirling is now **open-core / dual-licensed** — MIT core plus a non-FOSS
`proprietary/` directory. Since we're taking *approaches* (rasterize-to-redact, stamp
overlays), not copying Java, the license is largely moot. Just don't read from or copy
the `proprietary/` dir. Reading the MIT core for reference is fine.

## Feature-by-feature verdict

| Feature | Verdict | Where it runs | Effort | New footprint |
|---|---|---|---|---|
| **Redaction (real)** | **Port the concept** | pure TS (`pdf.js` + `pdf-lib`) | Medium | none |
| **Watermark / stamp** | **Port** | pure TS (`pdf-lib`) | Low | none |
| **Page numbers / Bates / header-footer** | **Port** (same mechanism as watermark) | pure TS (`pdf-lib`) | Low | none |
| **Merge / split / extract pages** | Easy bonus | pure TS (`pdf-lib`) | Low | none |
| **Better in-place text editing** | Improve, don't over-invest | pure TS (`pdf.js`) | Medium | none |
| **Compression / optimize** | Defer | needs Ghostscript/qpdf | — | large binary |
| **OCR (searchable scans)** | Optional only | `tesseract.js` WASM | Medium | ~a few MB + lang data |
| **Office conversion** | **Skip** | needs LibreOffice | — | ~hundreds of MB |

## The three things actually worth building

### 1. Real redaction (the best idea to steal from Stirling)

The trap: a black rectangle drawn over text is **not** redaction — the text underneath
is still selectable and extractable. Mesa's current `highlight` is a translucent rect;
reusing it for "redaction" would ship a security bug.

Stirling's own solution is instructive: on redact, it removes the matched text tokens
**and rasterizes the affected page to an image** so nothing is recoverable behind the
box. That approach ports perfectly into Mesa's stack, because Mesa already renders pages
to canvas with `pdf.js`:

1. User draws redaction rects on a page (reuse the existing drag-box UI).
2. Render that page to a canvas at high scale (already done in `usePdfEditor`).
3. Paint the redaction rects as opaque fills on the canvas.
4. Replace the page in the document: `pdf-lib` `embedJpg`/`embedPng` the flattened
   canvas and draw it as the full-page content, dropping the original page's text.
5. Route through the existing `apply()` byte-history path so undo/redo and verified
   save just work.

Honest tradeoff (same as Stirling's): redacted pages lose selectable text. That's the
price of guaranteed removal, and it's the right default. A "true token-removal without
rasterizing" mode is still an *open request* on Stirling itself
([issue #499](https://github.com/Stirling-Tools/Stirling-PDF/issues/499)) — i.e. nobody
has cleanly solved it — so don't spend effort chasing it. Ship the rasterize path.

New export to add alongside the others in `src/lib/pdf.ts`, e.g.
`redactRegions(bytes, { page, rects }[])`, plus a `redact` tool in `PdfView`.

### 2. Watermark, page numbers, stamps

All the same primitive: draw text or an image across pages with opacity and rotation via
`pdf-lib` `drawText` / `drawImage`. This is a couple hundred lines, no new deps, and
covers watermark, "DRAFT/CONFIDENTIAL" stamps, page numbering, Bates numbering, and
header/footer text. Add `addWatermark(bytes, opts)` and `addPageNumbers(bytes, opts)`
next to the current stamp functions. Cheapest high-visibility win.

### 3. Make the *existing* edit-text feel native (don't chase true editing)

Mesa already does durable visual replacement (extract run bounds with `pdf.js`, paint
over, redraw with `pdf-lib`). Stirling doesn't do better than this for arbitrary PDFs —
true content-stream glyph editing isn't a solved PDFBox feature either. So the win isn't
"port Stirling," it's polishing what's there:

- **Group text runs into words/lines.** `pdf.js` emits fragmented `textContent` items;
  merging adjacent items on the same baseline gives line-level edit targets instead of
  glyph-fragment targets. Pure `pdf.js` work in the existing text-extraction effect.
- **Match font + size on redraw** so replacements don't jump to a default face. Embed a
  standard-14 font that matches the run's measured height (partly done already).
- Keep the expectation honest in the UI: this is replace-in-place, not reflow.

## OCR — only if you truly need searchable scans

If OCR is a real requirement, the *only* option that respects "don't grow Mesa's scope"
is **`tesseract.js`** (Tesseract compiled to WASM) running in the webview — no server,
no native install, no JVM. It adds a moderate dependency and downloads language data on
demand (~10–15 MB per language). Flow: `pdf.js` renders each page → feed the canvas to
`tesseract.js` → get positioned words → write an invisible text layer with `pdf-lib` so
the scan becomes searchable/selectable.

Do **not** wire in OCRmyPDF/Tesseract-as-a-binary (Stirling's path) — that's a native
dependency and defeats the point. Treat OCR as an opt-in feature, gated behind a button,
not something that runs on open.

## Office conversion — skip it

Converting to/from Word/Excel/PowerPoint has no acceptable in-webview implementation.
Stirling does it by shelling out to **LibreOffice headless**, which is ~hundreds of MB
plus Python glue and is fragile across versions. Bundling that turns Mesa into a heavy
PDF appliance — the exact opposite of the goal. If a specific conversion is ever truly
needed, detect a *user-installed* LibreOffice and shell out to it as an optional Tauri
sidecar (mirroring Stirling's "enable the feature only if the binary exists" detection),
and never bundle it. For now: leave it out.

## One pattern worth copying wholesale

Stirling detects available binaries at startup and enables/disables features
accordingly. If Mesa ever adds any optional native capability, copy that idea: features
that need something heavy stay hidden unless the dependency is present, so the base app
stays small and the heavy stuff is strictly opt-in.

## Suggested order

1. **Watermark + page numbers** — smallest, most visible, zero risk. Warm-up that
   establishes the "stamp across pages" helper.
2. **Redaction (rasterize path)** — highest value, reuses the drag-box UI and the
   `apply()`/save pipeline; ship with the honest "redacted pages become images" note.
3. **Text-run grouping** — quietly upgrades the edit-text experience already shipped.
4. *(Optional, later)* **OCR via `tesseract.js`**, gated behind a button, only if
   searchable scans are actually requested.
5. **Skip** Office conversion, Ghostscript/qpdf compression, and any JRE/LibreOffice
   sidecar unless a concrete need forces it.

Everything in steps 1–3 stays inside Mesa's current `pdf.js` + `pdf-lib` stack: no new
runtime, no service, no meaningful size increase — just more of the PDF surface done
well.
