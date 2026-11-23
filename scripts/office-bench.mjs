// Synthetic Office benchmark (Node). Builds a 300-slide PowerPoint deck with
// 60 MB of incompressible pictures and a 100,000-row workbook, then times the
// work that runs on the interface thread: presentation open, render models,
// verified save; workbook open and insert/delete row. It measures JavaScript
// in Node only, not WebKit or WebView2 (worker messaging and paint excluded).
// Usage: node scripts/office-bench.mjs [runs] [pptx|xlsx]
// OFFICE_BENCH_OUT=<folder> keeps the generated files for native timing.
import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';

const runs = Math.max(1, Number(process.argv[2] ?? 3) || 3);
const only = process.argv[3] ?? 'all';
const directory = mkdtempSync(join(tmpdir(), 'mesa-office-bench-'));
try {
  const entry = join(directory, 'entry.ts');
  const modulePath = join(directory, 'office.mjs');
  const src = (path) => JSON.stringify(resolve(path));
  writeFileSync(entry, [
    `export { buildPackage, contentTypes, relationships } from ${src('src/lib/ooxml/fixtures/ooxmlFixtures.ts')};`,
    `export { deckParts } from ${src('src/lib/pptx/fixtures/pptxFixtures.ts')};`,
    `export { plainSheet, workbookParts } from ${src('src/lib/ooxml/fixtures/xlsxFixtures.ts')};`,
    `export { openPresentation, buildPresentationSave } from ${src('src/lib/pptx/pptxSession.ts')};`,
    `export { overlayView, loadDeck, xmlOf } from ${src('src/lib/pptx/pptxDeck.ts')};`,
    `export { renderSlide } from ${src('src/lib/pptx/pptxRender.ts')};`,
    `export { editTextBody } from ${src('src/lib/pptx/pptxTextEdit.ts')};`,
    `export { encodeXmlPart } from ${src('src/lib/pptx/xmlTree.ts')};`,
    `export { openXlsx } from ${src('src/lib/ooxml/xlsxOpen.ts')};`,
    `export * as draft from ${src('src/lib/ooxml/xlsxDraft.ts')};`,
    `export * as rowShift from ${src('src/lib/ooxml/xlsxRowShift.ts')};`,
  ].join('\n'));
  buildSync({ entryPoints: [entry], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const m = await import(pathToFileURL(modulePath).href);
  if (only !== 'xlsx') await benchPresentation(m);
  if (only !== 'pptx') benchWorkbook(m);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

/** OFFICE_BENCH_OUT=<folder> also writes the generated files there, for timing
 *  the same inputs in the native app (Diagnostics shows `office-open` marks). */
function keep(name, bytes) {
  if (process.env.OFFICE_BENCH_OUT) writeFileSync(join(process.env.OFFICE_BENCH_OUT, name), bytes);
}

function report(label, times) {
  console.log(`${label.padEnd(44)} best ${Math.min(...times).toFixed(1).padStart(7)} ms   (runs: ${times.map((x) => x.toFixed(0)).join(', ')})`);
}

function best(label, fn) {
  const times = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    result = fn();
    times.push(performance.now() - t);
  }
  report(label, times);
  return result;
}

/** Deterministic incompressible bytes (xorshift32). */
function noise(length, seed) {
  const out = new Uint8Array(length);
  let x = seed | 1;
  for (let i = 0; i < length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
}

function buildBigDeck(m, slides, pictureBytes) {
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
  const base = m.deckParts();
  const parts = {};
  for (const name of ['ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', 'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels', 'ppt/theme/theme1.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/notesMasters/_rels/notesMaster1.xml.rels']) parts[name] = base[name];
  const overrides = {
    'ppt/presentation.xml': `${CT}.presentation.main+xml`, 'ppt/slideLayouts/slideLayout1.xml': `${CT}.slideLayout+xml`,
    'ppt/slideMasters/slideMaster1.xml': `${CT}.slideMaster+xml`, 'ppt/notesMasters/notesMaster1.xml': `${CT}.notesMaster+xml`,
    'ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
  };
  const presRels = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }, { id: 'rId2', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' }, { id: 'rId3', type: 'theme', target: 'theme/theme1.xml' }];
  const ids = [];
  for (let i = 1; i <= slides; i++) {
    overrides[`ppt/slides/slide${i}.xml`] = `${CT}.slide+xml`;
    presRels.push({ id: `rId${i + 10}`, type: 'slide', target: `slides/slide${i}.xml` });
    ids.push(`<p:sldId id="${255 + i}" r:id="rId${i + 10}"/>`);
    parts[`ppt/slides/slide${i}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Slide ${i}</a:t></a:r></a:p></p:txBody></p:sp>`
      + `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 2"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="3048000" cy="2286000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
      + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${i}.xml.rels`] = m.relationships([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: 'image', target: `../media/image${i}.png` }]);
    parts[`ppt/media/image${i}.png`] = noise(pictureBytes, 0x9e3779b9 ^ i);
  }
  parts['[Content_Types].xml'] = m.contentTypes(overrides, { png: 'image/png' });
  parts['_rels/.rels'] = m.relationships([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]);
  parts['ppt/presentation.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${ids.join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  parts['ppt/_rels/presentation.xml.rels'] = m.relationships(presRels);
  return m.buildPackage(parts);
}

async function benchPresentation(m) {
  const bytes = buildBigDeck(m, 300, 200 * 1024);
  keep('Big deck.pptx', bytes);
  console.log(`\nPowerPoint: 300 slides, ${(bytes.length / 1024 / 1024).toFixed(1)} MiB package`);
  const opened = best('open (openPresentation)', () => m.openPresentation(bytes, 'pptx'));
  best('render all 300 slide models', () => opened.deck.slides.map((s) => m.renderSlide(opened.pkg, opened.deck, s)));
  for (const count of [8, 300]) {
    const reads = [];
    for (let r = 0; r < runs; r++) {
      const pkg = m.openPresentation(bytes, 'pptx').pkg;
      const t = performance.now();
      for (let i = 1; i <= count; i++) pkg.parts.get(`ppt/media/image${i}.png`);
      reads.push(performance.now() - t);
    }
    report(`first read of ${count} pictures`, reads);
  }
  const doc = m.xmlOf(opened.pkg, 'ppt/slides/slide1.xml');
  const changes = new Map([['ppt/slides/slide1.xml', m.encodeXmlPart(doc, m.editTextBody(doc, 0, 'Edited title'))]]);
  const saveTimes = [];
  for (let i = 0; i < runs; i++) {
    const fresh = m.openPresentation(bytes, 'pptx');
    const t = performance.now();
    if (!m.buildPresentationSave(fresh.pkg, changes)) throw new Error('expected saved bytes');
    saveTimes.push(performance.now() - t);
  }
  report('verified save, one text edit (fresh open)', saveTimes);
}

function benchWorkbook(m) {
  const rows = 100_000;
  const bytes = m.buildPackage(m.workbookParts({ sheets: [{ name: 'Big', xml: m.plainSheet(rows, 6) }], calcChain: false }));
  keep('Big book.xlsx', bytes);
  const part = 'xl/worksheets/sheet1.xml';
  console.log(`\nExcel: ${rows} rows x 6 columns, ${(bytes.length / 1024 / 1024).toFixed(1)} MiB package`);
  const { session } = best('open + index (in-thread fallback)', () => {
    const o = m.openXlsx(bytes);
    o.session.originalIndex(part);
    return o;
  });
  const start = m.draft.createDraft(session);
  const edited = m.draft.setCellText(session, start, part, 10, 1, 'changed');
  best('insert row 0, clean sheet (all work)', () => m.rowShift.shiftRows(session, start, part, 0, true));
  best('delete row 0 with a pending edit (all work)', () => m.rowShift.shiftRows(session, edited, part, 0, false));
  // Interface-thread share: the reference proof plus copying the job to the
  // worker and the result back (V8 serialize/deserialize stands in for postMessage).
  for (const [label, d, insert] of [['insert row 0, clean sheet', start, true], ['delete row 0 with a pending edit', edited, false]]) {
    best(`${label}: interface thread`, () => {
      const job = m.rowShift.prepareRowShift(session, d, part, 0, insert);
      deserialize(serialize({ index: job.index, edits: job.edits, row: job.row, delta: job.delta }));
      return job;
    });
    const job = m.rowShift.prepareRowShift(session, d, part, 0, insert);
    const result = best(`${label}: worker`, () => m.rowShift.runRowShift(job));
    best(`${label}: result copy back`, () => deserialize(serialize({ xml: result.index.xml, rowNumbers: result.index.rowNumbers })));
  }
}
