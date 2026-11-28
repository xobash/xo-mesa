# Office Editing (design)

Status: Word (`.docx`, `.docm`, `.dotx`, `.dotm`) opens in a read-only view
and edits in place in the desktop app. Excel workbooks (`.xlsx`, `.xlsm`,
`.xltx`, `.xltm`) open and edit through a Mesa-owned cell patch layer.
PowerPoint (`.pptx`, `.ppsx`; `.pptm` read-only) has a viewer and a limited
editor. OpenDocument text, spreadsheets and presentations open and edit
`content.xml` only (templates read-only). Acceptance is pending: no native run, no real-document corpus and no
reopen in Office has been done; the evidence so far is synthetic fixtures
and headless runs.

## Goal

Edit `.docx`, `.xlsx` and `.pptx` files in place with the least possible risk
of damage. An Office file is a ZIP package of XML parts and binary parts (ECMA-376
Part 2, Open Packaging Conventions). Most damage comes from editors that
rebuild the whole package and silently drop what they do not understand.

## Package layer (`src/lib/ooxml/`)

- **Open** reads and checks the whole ZIP structure before it decompresses
  anything. Mesa refuses the file when it finds one of these conditions:
  - an OLE compound file (a legacy `.doc`, `.xls` or `.ppt` file; a
    password-protected file is decrypted first, see below);
  - ZIP64 data or a split archive;
  - more than 10,000 entries;
  - a package above 256 MiB, an entry above 128 MiB, or more than 512 MiB of
    expanded data;
  - an entry of 1 MiB or more that expands more than 500 times;
  - an encrypted entry or an unknown compression method;
  - a symbolic link;
  - an unsafe or duplicate part name (names compare without case, as OPC
    requires);
  - bytes before, between or after the entries;
  - a local header that does not agree with the central directory.
- Each part is decompressed when Mesa first reads it, not at open
  (`partMaps.ts`): the checks above use only the ZIP records. Decompression
  stops at the entry's declared size and checks its CRC-32 before any byte is
  used; a part that fails is refused when read. A header that lies about the
  size cannot make Mesa expand more data. The capability scan reads only XML
  parts, so pictures and other binary parts that Mesa never shows are never
  decompressed, and a save copies them as raw records.
- **Save** writes only the parts whose bytes changed. Every other entry keeps
  its exact local record (compressed bytes, timestamp, extra fields), its
  central-directory record and its position in the archive. The archive
  comment is kept. A save with no real change returns the original bytes
  exactly. A replacement with identical bytes counts as no change.
- The saved bytes go through Mesa's verified write path like every other vault
  write ([Vault safety](vault-safety.md)).

## Capability gate

Before Mesa permits editing, it scans every part and reports which features
the file contains. The scanner reads XML in one linear pass without recursion,
so deep nesting cannot exhaust the stack. It refuses a part that declares a
DTD, which OOXML does not allow.

| Feature | Detected by | Class |
| --- | --- | --- |
| Tracked changes | WordprocessingML revision elements (`w:ins`, `w:del`, `w:moveFrom`, property changes, under any prefix bound to the namespace); spreadsheet revision parts | inline |
| Comments | comment parts and comment anchors | inline |
| Custom XML markup, smart tags | `w:customXml`, `w:smartTag` | inline |
| Content controls | `w:sdt` | inline |
| Alternate content | `mc:AlternateContent` | inline |
| Macros | `vbaProject.bin`, macro-enabled content types | part |
| Custom XML data parts | `customXml/` parts | part |
| Charts, SmartArt | chart and diagram content types | part |
| Embedded and OLE objects | `embeddings/` parts, OLE and package relationships | part |
| External links | external relationships other than hyperlinks; external-link parts | part |
| Pivot tables | pivot table and pivot cache content types | part |
| Data connections | connection and query table content types | part |
| Digital signatures | signature parts and relationships | blocking |

Each editor declares the features that it can keep without damage. The policy
is as follows:

- **inline** feature that the editor does not model: Mesa refuses to save. The
  editor would rewrite the XML that contains the feature.
- **part** feature that the editor does not model: Mesa saves with a warning.
  The parts are copied byte-for-byte, but references to them can become
  orphans.
- **blocking** feature: Mesa always refuses to save. Any change invalidates a
  signature.
- A file whose main part is not the editor's document type: Mesa refuses to
  save.

Viewing is always permitted when the package opens.

Every surface picks a file's viewer through one route (`FileKindView.tsx`):
the main pane, detached document windows and the browser-demo popout. So a
workbook, Word file, deck, OpenDocument file or RTF file shows the same viewer
in a detached window as in the main pane, view-only there; EPUB, ZIP, legacy
`.doc`/`.xls`/`.ppt` and unknown binary files show the details view
(`FileFallbackView`); an unknown extension whose first bytes are UTF-8 text
opens as text there too, as it does in the main pane. Evidence: `DocumentView.test.tsx` (each kind in the
detached window and the popout).

## Editor composition rule

An editor that serializes whole parts must not decide which parts Mesa writes.
Mesa compares each part that the editor outputs with the editor's own
no-edit output for the same file. A part that is unchanged keeps its original
bytes. Only parts that the edit really changed reach the package layer.

While a save writes, the Excel, OpenDocument, PowerPoint, RTF and image
editors refuse new edits (`useSaveLock`): a successful save adopts the bytes it
wrote, which would otherwise drop an edit made during the write. Word instead
counts edits made during the save and stays dirty.

## Word editor

### Engine and loading

- `@docx-editor.dev/core` 2.38.0 (Apache-2.0; dependencies MIT or Apache-2.0)
  lays out and edits the document. Its commercial `pro` and `editor-api`
  packages (comments, tracked changes, collaboration) are not installed.
- `components/wordEngine.ts` is its only importer. It loads by dynamic
  import when a Word file opens, never at startup. Mesa configures no font
  sources, so the engine measures text with its built-in estimate and fetches
  nothing; page breaks can differ from Word. The app CSP is unchanged. A file
  with embedded fonts can make the engine try its bundled HarfBuzz
  WebAssembly module, which the CSP blocks (no `'wasm-unsafe-eval'`); layout
  then keeps the estimate (Inferred). Shaped layout would need that CSP
  source, an owner decision.
- Bundle: the engine chunk is about 1.5 MB gzip (4.7 MB minified) plus a
  29 KB gzip stylesheet; a further 0.7 MB gzip chunk loads only if the
  engine asks for it. `vite.config.ts` gives the engine a private copy of
  `fflate`, otherwise its zip code would join the entry chunk. The bundle
  check lists `wordEngine-` and `WordView-` as lazy.
- Mesa registers none of the engine's diagnostics, hyperlink or print hosts.
  Inferred from the engine's types: diagnostics have no transport of their
  own and a link click only asks the (absent) host for a popover.

### Flow

1. Open: `openOoxmlPackage` must accept the file and its main part must be a
   Word document, else the details view (`FileFallbackView`) shows the
   reason. Legacy `.doc` files and files above 64 MiB go there; a
   password-protected file asks for its password first (below).
2. The engine mounts locked for viewing. Previews and detached windows stay
   view-only; editing needs the main pane, where `setBinaryDirty` guards
   navigation, close and vault actions.
3. Edit: Mesa first records the engine's no-edit output (the baseline), then
   unlocks editing. The toolbar offers only measured operations: undo, redo,
   bold, italic, underline, strikethrough, alignment, bullets, numbering,
   add row, add column and insert picture (PNG, JPEG, GIF up to 16 MiB).
4. Save: the engine output is compared with the baseline part by part; only
   changed, added or removed parts replace the original package's parts
   (`planWordSave`), spliced block by block for files with inline review
   features (below). The result is re-opened through the package layer and
   checked: every untouched entry must keep its raw record (compressed bytes,
   CRC-32, size), plus the checks below; then it is written through
   `saveDocumentBytes` with the opened
   bytes as the precondition. A save that changes nothing writes nothing.
5. After a save, the written bytes become the new original and the saved
   engine output the new baseline.

### Checks before every write (`lib/ooxml/wordChecks.ts`)

- **Integrity** (refuse): every relationship-namespace attribute in a changed
  part resolves in that part's relationships; internal relationship targets
  exist; every part has a content type; referenced styles, lists, footnotes
  and endnotes exist; required `w:val` values are present; text with leading
  or trailing spaces keeps `xml:space="preserve"`. Only problems the save
  would introduce count; problems already in the file do not block it.
- **Census** (confirm): counts content controls, custom XML and smart tags,
  tracked changes, bookmarks, comment anchors, note references, fields,
  links, drawings, embedded objects, tables, section breaks, alternate
  content and equations in the document's text parts. If the saved file has
  fewer of any, Mesa names them and asks before writing. This catches both a
  user deletion and an engine drop.

### Gate decision for Word

The Word editor declares no preserved features of its own
(`WORD_EDITOR_PRESERVES`). Tracked changes, comments, content controls,
custom XML markup and alternate content (`WORD_SPLICE_PRESERVES`) are kept
only by saves that go through the paragraph splice (below); a file with any
of them always saves that way. A digital signature turns in-place Save off
with the reason on screen; editing and **Save as copy** (`<name> copy.docx`,
a missing-file precondition) stay available and the original is never
touched. Part features (macros, charts, SmartArt, embedded objects, custom
XML data, external links) save with a visible warning. A file that changes
on disk while edited keeps the edits and blocks Save; Save as copy still
works and Discard (confirmed) loads the newer version.

### Paragraph splice (`lib/ooxml/wordSplice.ts`, `wordSplicePart.ts`)

The engine re-serializes whole parts and drops or flattens features it does
not model. For a file with inline review features Mesa therefore writes the
**original** part with only the changed blocks replaced:

- Story parts (document body, headers, footers, footnotes, endnotes) are
  split into blocks: the children of `w:body` (or of the header, footer or
  notes root): paragraphs, tables, content controls, notes. The body's final
  `w:sectPr` and everything outside the blocks stay the file's own; an edit
  that changes them is refused.
- The engine's no-edit output must have the same number of blocks as the
  file (they are matched by position, and each changed block's text is
  compared). Its blocks are matched with the edited output in order by a
  bounded diff (`blockDiff.ts`: Myers, at most 2,000 edit steps, then the
  whole changed middle counts as replaced). Untouched blocks keep their
  original bytes.
- Refused, naming the feature and the block (kind, number and opening
  text): a changed or removed block that holds a tracked change, comment
  anchor, content control, custom XML tag or alternate content; and a
  change inside, or new text inserted inside, a range that spans blocks:
  a comment, bookmark, permission range, tracked move or custom XML change
  range, or a tracked paragraph mark (it joins its paragraph to the next).
  Save as copy then falls back to whole-part composition with the census
  confirmation.
- Namespace prefixes the inserted blocks use are added to the original root
  when missing (and to `mc:Ignorable` when the engine marks them ignorable);
  a prefix bound to another URI in the file is refused.
- Relationship parts and `[Content_Types].xml` are merged entry by entry:
  the original entries, plus those the edit added, minus those it removed.
  An entry the edit changed in place, or a new entry whose id clashes, is
  refused. Comment, extended-comment and people parts are never written.
- After composing, every original part must keep a content type, and the
  census may not lose any content control, custom XML tag, smart tag,
  tracked insertion or deletion, comment anchor or alternate content.
- A UTF-16 story part is refused; a UTF-8 byte-order mark is kept.

Evidence: `wordSplice.test.ts` (fflate fixtures: tracked insert and delete,
comment and content control kept byte-for-byte while another paragraph
changes; edits inside the comment, the control and the tracked paragraph,
inside a multi-paragraph comment range and next to a tracked paragraph mark
refused with the place named; relationship and content-type merge; section
change and prefix conflict refused; Save as copy fallback; linear time),
`blockDiff.test.ts`, and `wordEngine.test.ts`, where the real engine adds a
list to the first paragraph of a file with all three features and the other
blocks keep their bytes. Inferred, not measured: real Word documents and
Word's reaction to the spliced parts. The engine gives each re-serialized
paragraph a `w14:paraId`; a clash with an id in an untouched paragraph is
possible but not checked.

### Spike evidence (2026-11-17)

Fixtures: three files written by macOS `textutil -convert docx` (from HTML,
RTFD and RTF; textutil drops images, links, tables and footnotes and writes
the non-standard `w:sz-cs`) and four written by fflate: a full document
(styles, numbering, bullets, footnote, endnote, bookmark, internal and
external links, simple and complex fields, table with shading and vertical
merge, inline picture, equation, VML shape, ruby, permission range, unknown
`mc:Ignorable` extension element, two sections with portrait/landscape,
first-page and default headers, shared footer, custom properties), the same
with tracked changes, a comment, a content control and alternate content, a
`.docm` with a VBA part and a `.dotx`. Each fixture ran no-op, text replace,
bold plus alignment, add table row, insert picture and header text edit.

Measured, after the composition rule:

- The no-edit output is deterministic and identical across engine instances
  (all 7 fixtures).
- Every edit changed only the parts it should: `document.xml`, or the header
  part, or for a picture also `[Content_Types].xml`, the relationships and
  the new media part. All other parts kept their original bytes.
- No element or attribute was lost in any changed part, except
  `xml:space="preserve"` on text without edge spaces and `w:rsidRPr` on a run
  split by formatting; neither changes the document.
- No new reference problems; all 42 composed files open in macOS's own
  Word reader (`textutil`).
- Replacing the whole text of a run can take the formatting of the next run
  (seen with textutil's trailing empty runs); the result is visible on screen.
- The engine does not validate command arguments: a misspelled alignment
  option wrote `<w:jc/>`. Mesa sends only typed commands, and the integrity
  check refuses a missing required value.
- No runtime network request (fetch and XMLHttpRequest trapped).

Inferred, not measured: behaviour with real Word documents, Word's reaction
to the engine's re-serialized parts, layout in WebKit and WebView2,
performance on large files, rich paste, delete and merge operations.

## PowerPoint (`src/lib/pptx/`, `PresentationView`)

No mature, permissively licensed presentation editor keeps unknown content
safely, so Mesa renders slides itself and edits by splicing XML text inside
the parts it changes. The parser (`xmlTree.ts`) is one linear pass with an
explicit stack, records each element's source span and refuses DTDs,
mismatched tags and parts above 16 Mi characters or 400,000 elements.

### Viewer

- Slide order comes from `p:sldIdLst`; hidden slides are marked. The list
  shows thumbnails; the main slide scales to the pane; speaker notes come from
  the notes page's body placeholder.
- Drawn: shape positions (`a:xfrm`, groups, rotation, flips), solid and
  gradient (first stop) fills, outlines, rectangles, rounded rectangles and
  ellipses, text with runs, levels, alignment, bullets and auto-numbers,
  pictures (PNG, JPEG, GIF, BMP, WebP, SVG) as blob URLs of package parts,
  connectors as lines, tables as plain text, backgrounds.
- Resolved: theme colours through the master colour map (with `lumMod`,
  `lumOff`, `tint`, `shade`, `alpha`), theme fonts (`+mj-lt`, `+mn-lt`), and
  placeholder position and text style from the layout and master.
- Not drawn, shown as a labelled box: charts, SmartArt, embedded objects, ink,
  linked or unsupported pictures (EMF, WMF, TIFF). Other preset and custom
  geometry is drawn as a box with its name in the tooltip. Video and audio
  show their poster with a label. Nothing is fetched from the network.

### Editing

Opens read-only. **Edit** turns on these operations, each a set of part
changes over the opened package (undo restores earlier sets):

- **Text**: click a text box, edit one paragraph per line. Only the `a:t`
  content of runs that changed is rewritten; their `a:rPr` stays. A new
  paragraph copies the previous paragraph's `a:pPr`, last run properties and
  `a:endParaRPr`. A text box with a manual line break, a field, an equation,
  XML comments or alternate content is refused with the reason.
- **Notes**: the same text edit on the notes page body. A slide without a
  notes page is refused (Mesa does not create one).
- **Reorder**: only the order of `p:sldId` entries in `presentation.xml`.
- **Delete**: removes the `p:sldId`, its presentation relationship, and every
  part that was reachable from the package root before and is not after (the
  slide, its relationships part, its notes page, and charts or media only it
  used), with their content-type overrides. Parts that stay reachable
  (layouts, shared pictures) and parts that were already unreachable stay
  untouched. Refused when another slide links to the slide, when a custom
  show or other `presentation.xml` element uses its relationship id, and for
  the last slide.
- **Duplicate**: copies the slide part byte-for-byte after the original, with
  a new id and relationship. Its notes page is copied and the two back links
  are retargeted. Refused when the slide or notes relationships include
  anything other than a layout, notes master, picture or hyperlink (charts,
  media, comments, tags, embedded objects), because those parts cannot be
  shared safely between two slides.
- Decks with sections are refused for reorder, delete and duplicate: sections
  list slides by id and Mesa does not update them.
- Not changed: `docProps/app.xml` slide counts and titles (informational).

The gate uses `decideOoxmlEditPolicy` with alternate content and comments
preserved (splice edits never re-serialize a part; presentation comments are
anchored by position). Charts, SmartArt, embedded objects, custom XML and
external links give a warning, shown in Edit and confirmed on Save. Digital
signatures, a non-presentation main part and macros (`.pptm` or a VBA part)
keep the file read-only with the reason on screen.

### Saving

1. Changes equal to the opened part are dropped; nothing effective means
   nothing is written.
2. The package layer writes only changed parts.
3. The candidate is re-opened through the package layer. Mesa checks that
   every unchanged entry keeps its raw record (compressed bytes, method,
   CRC-32, size; compared without decompressing), every changed part saved as
   edited, the slide list loads, and no new dangling relationship or untyped
   part exists.
4. `saveDocumentBytes` writes with the opened bytes as precondition.
5. A file changed on disk while there are edits keeps the edits, blocks Save
   and offers **Save as copy** (a new `… copy.pptx`, must not exist). A clean
   view reloads.

Dirty state reaches the store through `setBinaryDirty`, so close, navigation
and vault switches ask first. Detached windows show presentations
read-only.

Thumbnails draw their pictures only once they come within 600 px of the
visible list (IntersectionObserver), so opening a deck decompresses only the
pictures on screen. A picture that fails its checks draws as missing.

Measured (Node 22, macOS, `npm run bench:office`, synthetic
300-slide deck with 59 MiB of incompressible pictures, best of three to
five runs): open 41 to 50 ms (was 364 to 500 ms), render all 300 slide
models 7 to 11 ms, first read of 8 pictures 6 to 8 ms (all 300: 218 to
264 ms, the cost thumbnails now avoid), verified save after a text edit 58
to 75 ms (was 533 ms; one run on a loaded machine reached 140 ms). Opening
and saving still run on the interface thread, below the 100 ms action
threshold on a quiet machine. Relationship lists are cached per part buffer (`relsOf`), so the
slide list loads in linear time. WebKit and WebView2 timings are not
measured.

Tests: `pptxEdit.test.ts` (fixture with titles, bullets, a picture, notes, a
chart, a video and a hidden slide; identity, single text edit, notes,
reorder, delete, duplicate, gate), `xmlTree.test.ts`,
`PresentationView.test.tsx`, `MediaView.test.tsx`.

### Other presentation formats

Legacy `.ppt` files show their slide text read-only (see
[Legacy binary Office files](#legacy-binary-office-files)). OpenDocument
`.odp`: see [OpenDocument](#opendocument-srclibodf).

The capability scan walks the tags of a part only when the part spells a
Word or markup-compatibility namespace or holds a `<!` declaration; a
namespace must be declared in the part that uses it, so other parts (large
worksheets) cost a few substring searches.

## Spreadsheet editor (`lib/ooxml/xlsx*.ts`)

No free editor keeps a workbook intact: SheetJS Community Edition drops
styles on write, ExcelJS loses drawings and charts, and the Univer import and
export need its paid server. Mesa therefore owns a cell patch layer over the
package layer. It never builds a tree of a part and never re-serializes XML
it did not change.

### Reading

- `xlsxWorkbook.ts` reads the sheet list, defined names, the date system and
  the shared-string and style parts (both parsed on first use).
- `xlsxSheet.ts` indexes a worksheet in one linear pass: only the position of
  each row. Cells of a row are parsed when the row is shown or edited, and the
  view keeps at most 4,096 parsed rows. Rows and columns of the grid are
  windowed (`DataGrid.tsx`, shared with the CSV table).
- Opening, indexing a sheet, moving rows and writing a save run in a module
  worker (`xlsx.worker.ts`), so a large workbook does not block the interface. Only where
  workers never existed does the same code run in the calling thread. A
  worker that crashes or stays silent for 120 s is stopped; the request in
  progress fails and can be retried. The next request starts a new worker,
  which re-opens the last opened bytes first, so Save still works. After
  three restarts each request fails and asks for the file to be reopened
  (`xlsxWorkerClient.test.ts`).
- Mesa does not calculate. A formula cell shows its cached result, and the
  view says so. Number formats are rendered locale-neutral: dates and times
  in ISO 8601; numbers with the format's decimals, grouping, percent sign,
  exponent and currency text.

### Cell edits

- Only the changed `<c>` elements of the affected worksheet part are
  rewritten. Each keeps its other attributes, including the style index `s`.
  A new cell or row is inserted in column and row order; a row's `spans` hint
  is dropped when a new cell falls outside it; the `dimension` grows to cover
  new cells.
- Text is written as an inline string (`t="inlineStr"`), not appended to the
  shared-string table. The shared-string part then never changes, so a large
  table is never rewritten, its `count` stays true for the cells that use it,
  and a single-cell edit changes one worksheet part. Excel, LibreOffice and
  other readers read inline strings, and Excel moves them into its table on
  its next save. Literal `_xHHHH_` text and control characters are escaped
  (ECMA-376 Part 1, 22.9.2.19).
- A typed formula is written without a cached value (`<v>`), so no stale
  result is stored. When any cell changes in a workbook that has formulas,
  `fullCalcOnLoad="1"` is set on `calcPr` (inserted at its schema position
  when absent), so Excel recalculates every formula on open instead of
  trusting cached results that the edit made stale.
- The calculation chain (`calcChain.xml`) lists formula cells. An entry for a
  cell that no longer holds a formula makes Excel report the file as damaged
  and repair it. Mesa therefore removes the part, its workbook relationship
  and its content-type override only when formula cells appear, disappear or
  move; Excel rebuilds the chain. Value-only edits keep it byte-identical.
- Refused per cell, with the reason: cells in an array formula, the anchor of
  a shared formula that other cells use, data-table cells, cells with rich
  value metadata (`vm`, `cm`) or an extension list, and table header cells
  (Excel requires them to match the table definition).
- Refused per sheet: Strict Open XML, a part that is not plain UTF-8 (a UTF-8
  byte-order mark is kept), rows out of order, comments or CDATA in the cell
  data, and rows or cells without an explicit address.

### Rows and sheets

- Insert row and delete row renumber the rows and cells below and move merged
  ranges (a merge that spans the point grows or shrinks; a one-row merge in a
  deleted row is removed) and the `dimension`. Mesa does not rewrite
  references, so it refuses the change, naming the cause, when anything might
  refer to the moved rows: a formula in any sheet or a defined name that
  refers to the moved rows (whole-column references are safe), INDIRECT or
  OFFSET anywhere, shared or array formulas on the sheet, a sheet element
  with its own ranges (conditional formatting, data validation, hyperlinks,
  drawings, comments, tables, filters, page breaks and others), any linked
  sheet part (pivot table, drawing, table), or another part that names the
  sheet (charts, pivot caches, form controls).
- A row move runs in two halves (`xlsxRowShift.ts`): the refusal proof reads
  the sheet as the draft holds it on the interface thread (a stored formula
  that a pending edit replaces is skipped; pending formulas and a pending
  value in the last row are checked), then the worker writes the pending
  cells, renumbers the rows and re-indexes. While it runs the view says
  "Inserting row N…" and cell edits, undo, sheet changes and saves are
  disabled; a result for a draft that changed meanwhile is dropped. The
  usual cell reference (`<c r="B12"`) gets only its row digits replaced; any
  other spelling is parsed and written in canonical form. Measured (Node 22,
  100,000 rows x 6 columns): 318 to 451 ms of work, of which about 32 ms
  (proof and job copy) plus about 8 ms (result copy) stays on the interface
  thread; worker messaging in WebKit or WebView2 is not measured.
- Rename sheet checks Excel's naming rules and refuses when a formula, a
  defined name or another part mentions the sheet; Excel, which updates
  references, should rename it then.
- Add sheet appends an empty worksheet: a new part, its workbook
  relationship, its content-type override and its `<sheet>` entry. The
  document properties (`docProps/app.xml`) keep their old sheet list; Excel
  does not read it and rewrites it on its next save.

### Save

1. `planXlsxSave` builds the part changes. No effective change means no write.
2. The worker writes the package (unchanged entries copied byte-for-byte) and
   re-opens it through the package layer: every unchanged entry must keep its
   compressed bytes and CRC, every changed part must equal the plan and be
   well-formed XML (`xmlWellFormed.ts`), the sheet list must match, and every
   edited cell must read back as typed.
3. `saveDocumentBytes` writes those verified bytes with the opened bytes as
   the on-disk precondition. A change on disk refuses the save and keeps the
   edits; Save as copy writes a new file.

Evidence: `xlsxEdit.test.ts` (identity, single-cell edit with every other
entry byte-identical, inline strings, formulas and the calculation chain,
rows, merges, sheets, refusals, chart and pivot fixtures, prefixed XML),
`xlsxParts.test.ts` (references, number formats, index, well-formedness,
100,000 rows, worker client, worker row move), `SpreadsheetView.test.tsx`
(read-only first, explicit Edit, dirty state, verified save, gate prompts and
refusals, row move progress and blocking).

### Other spreadsheet formats

- Legacy `.xls` workbooks show their cells read-only (see
  [Legacy binary Office files](#legacy-binary-office-files)).
- Binary `.xlsb` workbooks open in the file details view with the reason:
  Mesa cannot write their binary format without risking damage. Saving a copy
  as `.xlsx` in Excel or LibreOffice makes them editable.
- OpenDocument `.ods`: see [OpenDocument](#opendocument-srclibodf). Flat
  `.fods` files open in the file details view with the reason.
- Password-protected workbooks open with their password (below).


## Legacy binary Office files

`.doc`/`.dot`, `.xls`/`.xlt` and `.ppt`/`.pps`/`.pot` are OLE compound files
with binary records. No mature free writer keeps them intact, so Mesa never
writes them. The file details view shows a **Content** tab (default) next to
**Bytes**; the readers (`src/lib/legacyOffice/`) load lazily with that tab.

- **Container** (`cfb.ts`, [MS-CFB] v3/v4): the whole file is read through the
  bounded range reader (one file version, at most 64 MiB). Every sector chain
  is followed with a visited map and a step limit; the directory tree is
  walked with an explicit stack. A loop, a pointer outside the file, a chain
  shorter than its stream, an impossible table size or a truncated sector
  refuses the file with the reason.
- **Word** (`wordBinary.ts`, [MS-DOC], Word 97-2003): FIB → piece table →
  main-document text (Windows-1252 and UTF-16 pieces). Paragraph table flags
  from the PAPX pages turn cell and row marks into tables; without them two
  cell marks end a row. Field codes are dropped, field results kept. Headers,
  footers, footnotes, comments and text boxes are not read. Word 6/95 files
  are refused.
- **Excel** (`excelBinary.ts`, [MS-XLS] BIFF8): sheets, shared strings
  (across CONTINUE records), numbers, RK and MULRK values, booleans, errors,
  labels and the cached result of each formula, formatted through the `.xlsx`
  number-format code (dates as ISO 8601). Shown in the shared `DataGrid`,
  read-only. At most 1,000,000 cells; Excel 5/95 is refused; chart and macro
  sheets are listed as not shown.
- **PowerPoint** (`pptBinary.ts`, [MS-PPT]): `Current User` → edit chain
  (loop-checked) → persist directory → slide list; each slide's title, body
  and text boxes in order, and its speaker notes.
- **Encryption**: Word `fEncrypted`/`fObfuscated`, Excel `FILEPASS`,
  PowerPoint's encrypted header token or encryption reference, and
  `EncryptionInfo`/`EncryptedPackage` streams each show "password-protected"
  with what to do; nothing is decrypted.

**Make editable copy** (`legacyConvert.ts`, `components/legacyOfficeCopy.ts`)
builds a new minimal `.docx`, `.xlsx` or `.pptx` with the package layer's ZIP writer, re-opens it
through the package layer and checks it carries the content (Word text, sheet
names and date system, slide count, layouts and notes, and that the editor
gate allows editing). A `confirmAction` names the new file, says the original
is not changed and lists what the copy loses:

| Copy | Keeps | Loses |
| --- | --- | --- |
| `.docx` | main text, paragraphs, line and page breaks, tabs, tables as plain cells | formatting, lists, headers/footers, footnotes, comments, tracked changes, text boxes, images, objects, macros; fields keep their result only |
| `.xlsx` | every worksheet's values and number formats (dates included), hidden state, 1904 date system | formulas (each keeps its last calculated value), fonts, colours, borders, widths, merges, comments, names, charts, chart sheets, images, pivots, validation, macros |
| `.pptx` | slide order, titles, text, speaker notes on a plain layout | design, positions, formatting, images, charts, tables, shapes, animations, transitions, hidden marks, macros |

The copy is named `<name>.<ext>` beside the original (`safeBaseName`; a
numbered sibling when taken) and written with a missing-file precondition and
the same check on the read-back bytes, then opened in the Word, Excel or
PowerPoint editor.

Evidence: `legacyOffice.test.ts` (hand-built CFB, `.doc`, `.xls` and `.ppt`
structures documented in `fixtures/legacyFixtures.ts`; sector, directory and
edit loops, out-of-range and truncated chains, impossible counts, encryption,
pre-97 formats, copy round trips), `legacyOfficeCopy.test.ts`,
`MediaView.test.tsx`. macOS `textutil` reads a generated `.docx`. Not done:
real Office-written legacy files, reopening copies in Office, native run.

## OpenDocument (`src/lib/odf/`)

Text (`.odt`), spreadsheets (`.ods`) and presentations (`.odp`) open in
`OpenDocumentView`, a lazy chunk. Templates (`.ott`, `.ots`, `.otp`) open
read-only. Flat XML files (`.fodt`, `.fods`, `.fodp`) stay in the file
details view with the reason.

- **Package.** The bounded ZIP reader and lossless writer of the OOXML layer
  open and save the file. `mimetype` names the kind and must agree with the
  extension's view. Mesa changes only `content.xml`; `styles.xml`,
  `meta.xml`, `settings.xml`, the manifest and every other entry keep their
  exact local records, so `mimetype` stays first and stored.
- **Gate** (`odfPackage.ts`). Editing is off, with the reason shown, for a
  template, a signature (`META-INF/*signatures*.xml`), any manifest
  `encryption-data`, a `mimetype` entry that is not first and stored, a
  manifest that does not list every entry outside `META-INF/`, UTF-16
  content, and a spreadsheet with tracked changes. An encrypted
  `content.xml` cannot be viewed: the details view opens with the reason.
  Macros (`Basic/`, `Scripts/`) need a confirmation before each save; Mesa
  never runs them.
- **Save.** The candidate is re-opened and checked before
  `saveDocumentBytes` (opened bytes as precondition): same kind, `mimetype`
  first and stored, manifest complete, the same entries, every entry except
  `content.xml` byte-equal, `content.xml` exactly as edited and well-formed,
  and a kind-specific read-back. A no-op edit writes nothing. After the
  write, the editor continues from the package that check opened from the
  candidate bytes (`openSavedOdfPackage`); it does not read the file again.
- **Text.** Headings, paragraphs, lists, tables (one level), images and
  bold, italic, underline and colour from automatic and common styles. Edit
  a paragraph's text, or bold or italicize a selection. White space follows
  ODF 1.3 Part 3 section 6.1.2 (`text:s`, `text:tab`, `text:line-break`).
  Bookmarks, frames and comments in a paragraph are kept in place. A
  paragraph with links, fields, notes, nested spans or tracked-change marks
  is read-only with the reason; so is every paragraph inside a
  `text:change-start` ... `text:change-end` region. Formatting adds
  `Mesa_T<n>` automatic text styles to `content.xml` only, each derived from
  the run's existing style. An edit re-parses `content.xml`, then takes over
  every paragraph whose XML did not change from the model before it, so only
  the edited paragraph is read and drawn again (Measured, Node 22, 10,000
  paragraphs: 52 to 23 ms per key; the XML parse is the rest).
- **Spreadsheets.** Sheets show in the shared `DataGrid`. Cell edits splice
  only the touched cells; a repeated row or cell run is split only where an
  edit lands. Numbers are written as `float`, other text as `string`, and
  `=...` as `table:formula="of:=..."` without a cached value; formulas use
  OpenFormula syntax (`=SUM([.A1:.A3])`). Tabs and line breaks in an
  attribute are written as character references, so a conforming reader
  keeps them, and characters XML 1.0 cannot carry are dropped (one escaper
  pair, `xmlScan.ts`; `odsEscape.test.ts`). Covered cells, array formulas,
  protected sheets and columns outside the sheet's `table:table-column`
  definitions refuse with the reason. Each saved cell must read back as
  typed.
- **Presentations.** Slides draw through the PowerPoint `PresentationSlide`
  model (frames, text boxes, custom shapes, lines, pictures, tables). Edit
  text boxes and notes (one paragraph per line; a new line copies the last
  paragraph's list item) and move slides up or down. An edit keeps the
  render model of every slide it did not change, so only the edited slide
  and its thumbnail are drawn again (Measured, Node 22, 300 slides: slide
  models 11 to 1.5 ms per key).

Acceptance is pending: the evidence is synthetic fflate fixtures and jsdom
runs, not a native run or a reopen in LibreOffice.

## Password-protected files

A `.docx`, `.xlsx` or `.pptx` saved with a password is an OLE compound file
(MS-CFB) holding `EncryptionInfo` and `EncryptedPackage` streams
(MS-OFFCRYPTO 2.3.4.4). `EncryptedOfficeGate` wraps the Word, Excel and
PowerPoint views; the editors see only the decrypted package through
`OfficeByteSourceContext` and never handle the encrypted form.

- **Open:** the shared `Modal` asks for the password. A wrong password says
  so and clears the field; attempts run one at a time, at most 20 per prompt,
  and closing and reopening the file starts again (no lockout). Cancel shows
  the file details view with an **Enter password** button.
- **Agile encryption** (Office 2010 and later): password to SHA-1/SHA-2 with
  the file's spin count (at most 10,000,000), verifier check, package secret
  key, 4096-byte AES-CBC segments, and the HMAC over the whole encrypted
  stream checked before anything is shown; a mismatch refuses the file.
  Only AES with CBC and SHA-1, SHA-256, SHA-384 or SHA-512 are supported;
  others give the reason.
- **Standard encryption** (Office 2007, AES-128 ECB, SHA-1) opens read-only:
  saving would have to change the file to Agile encryption. It has no HMAC;
  the package layer's CRC-32 checks still catch damage.
- **Read-only with a reason:** files that also have a certificate key
  encryptor (saving would remove it). **Refused with a reason:**
  certificate-only, extensible (third-party) and RC4 CryptoAPI encryption.
  Legacy RC4/XOR `.doc`, `.xls` and `.ppt` files and password-protected
  OpenDocument files show the reason in the file details view, read-only.
- **Save:** the editor's verified package is encrypted again with Agile,
  keeping the file's cipher, hash, key size, salt sizes and spin count, with a
  new secret key, new salts and a new HMAC. Every other stream of the original
  compound file is copied byte-for-byte. The new compound file is decrypted
  back and compared with the package before `saveDocumentBytes` writes it with
  the encrypted bytes on disk as the precondition. A save with no change
  writes nothing. **Save as copy** is encrypted with the same password.
- **Password lifetime:** the password goes to one module worker per open file
  (`lib/officeCrypto/officeCrypto.worker.ts`), which also runs the key
  derivation and AES. Closing the view terminates the worker. The password is
  never stored, logged or written to settings.
- **External change:** bytes on disk that differ from the last opened or saved
  version are decrypted with the held password; Mesa's own save echo is
  recognised by its encrypted bytes.

Measured (Node 22 WebCrypto, macOS, heavily loaded machine, 2026-11-17):
100,000 SHA-512 iterations take 0.8 to 1.0 s in a plain Node process and
2 to 7 s inside the test runner; a save runs the derivation twice (new key
and self-check). Encrypting and decrypting the package itself is small next
to the derivation. Not measured in WebKit or WebView2.

Tests: `cfb.test.ts` (round trip, DIFAT, name order, hostile chains and
directories), `officeCrypto/encryptedOffice.test.ts` (known answers from an
independent reference, wrong password, HMAC tamper, unsupported schemes,
re-encryption), `EncryptedOfficeGate.test.tsx`, `officeByteSource.test.ts`,
`odfEncryption.test.ts`, `legacyOfficeEncryption.test.ts`.

## Not yet decided

- Lifting inline features into `WORD_EDITOR_PRESERVES` (whole-part saves)
  needs a real-document corpus run. The free engine renders tracked changes
  in their final state only, so the splice refuses edits in tracked
  paragraphs.
