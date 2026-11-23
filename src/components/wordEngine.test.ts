// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest';
import { buildPackage, docxParts } from '../lib/ooxml/fixtures/ooxmlFixtures';
import { openOoxmlPackage } from '../lib/ooxml/ooxmlPackage';
import { planWordSave } from '../lib/ooxml/wordCompose';
import { mountWordSurface } from './wordEngine';

// Runs the real layout engine (no canvas in jsdom: layout uses its estimate)
// to pin the facts the composition rule depends on.

const T = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style></w:styles>';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">Header </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:hdr>';
const BODY = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="top"/><w:r><w:t>Title</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">Body text </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>'
  + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';

const ORIGINAL = buildPackage(docxParts(BODY, { 'word/styles.xml': STYLES, 'word/header1.xml': HEADER },
  { 'word/styles.xml': `${T}.styles+xml`, 'word/header1.xml': `${T}.header+xml` },
  [{ id: 'rIdS', type: 'styles', target: 'styles.xml' }, { id: 'rIdH', type: 'header', target: 'header1.xml' }]));

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

it('keeps untouched parts byte-for-byte and the edited part checked when the real engine edits', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let changes = 0;
  const surface = mountWordSurface(host, ORIGINAL, { onChange: () => { changes++; }, onSelection: () => {} });
  try {
    expect(surface.run({ type: 'toggleList', kind: 'bullet' })).toMatch(/viewing/);
    const baseline = await surface.save();
    expect(await surface.save()).toEqual(baseline); // the no-edit output is deterministic
    const original = openOoxmlPackage(ORIGINAL);
    expect(planWordSave(original, baseline, baseline)).toEqual({ kind: 'unchanged' });

    expect(surface.setEditing(true)).toBeNull();
    expect(surface.run({ type: 'toggleList', kind: 'bullet' })).toBeNull();
    expect(changes).toBeGreaterThan(0);
    const plan = planWordSave(original, baseline, await surface.save());
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.changedParts).toContain('word/document.xml');
    for (const name of ['word/styles.xml', 'word/header1.xml', 'docProps/core.xml']) {
      expect(plan.changedParts).not.toContain(name);
      expect(plan.package.parts.get(name)).toEqual(original.parts.get(name));
    }
    expect(plan.losses).toEqual([]);
  } finally {
    surface.destroy();
    host.remove();
  }
}, 30_000);

const REVIEW_BLOCKS = [
  '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>One</w:t></w:r><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t xml:space="preserve"> added</w:t></w:r></w:ins><w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve"> gone</w:delText></w:r></w:del></w:p>',
  '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>',
  '<w:sdt><w:sdtPr><w:alias w:val="Box"/><w:id w:val="5"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>In control</w:t></w:r></w:p></w:sdtContent></w:sdt>',
];
const REVIEW = buildPackage(docxParts(`${REVIEW_BLOCKS.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`, {
  'word/styles.xml': STYLES,
  'word/comments.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="A"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>',
}, { 'word/styles.xml': `${T}.styles+xml`, 'word/comments.xml': `${T}.comments+xml` },
[{ id: 'rIdS', type: 'styles', target: 'styles.xml' }, { id: 'rIdC', type: 'comments', target: 'comments.xml' }]));

it('splices a real engine edit so tracked changes, comments and content controls keep their bytes', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const surface = mountWordSurface(host, REVIEW, { onChange: () => {}, onSelection: () => {} });
  try {
    const baseline = await surface.save();
    expect(surface.setEditing(true)).toBeNull();
    expect(surface.run({ type: 'toggleList', kind: 'bullet' })).toBeNull();
    const original = openOoxmlPackage(REVIEW);
    const plan = planWordSave(original, baseline, await surface.save());
    expect(plan).toMatchObject({ kind: 'ready' });
    if (plan.kind !== 'ready') return;
    const doc = new TextDecoder().decode(plan.package.parts.get('word/document.xml'));
    for (const block of REVIEW_BLOCKS.slice(1)) expect(doc).toContain(block);
    expect(doc).not.toContain(REVIEW_BLOCKS[0]);
    expect(doc).toContain('w:numPr');
    expect(plan.package.parts.get('word/comments.xml')).toEqual(original.parts.get('word/comments.xml'));
    expect(plan.losses).toEqual([]);
  } finally {
    surface.destroy();
    host.remove();
  }
}, 30_000);
