import { buildPackage, contentTypes, relationships, type FixtureParts } from "../../ooxml/fixtures/ooxmlFixtures";

// Hand-made presentation fixture for tests, zipped by fflate (never by the
// code under test): a title slide with bullets and notes, a picture slide, a
// chart and video slide, and a hidden slide.

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NSDECL = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const CT = "application/vnd.openxmlformats-officedocument.presentationml";

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`;

/** 1×1 transparent PNG. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function xfrm(x: number, y: number, cx: number, cy: number): string {
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

function placeholder(id: number, name: string, ph: string, body: string, geometry = ""): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${geometry}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function textBox(id: number, box: string, body: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${box}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function slide(tree: string, attrs = ""): string {
  return xml(`<p:sld ${NSDECL}${attrs}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
}

export const SLIDE1_TITLE = "Quarterly review";

const slide1 = slide(
  placeholder(2, "Title 1", '<p:ph type="title"/>', `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${SLIDE1_TITLE}</a:t></a:r></a:p>`) +
  placeholder(3, "Content 2", '<p:ph idx="1"/>',
    '<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Revenue </a:t></a:r><a:r><a:rPr lang="en-US"/><a:t>up 12%</a:t></a:r></a:p>' +
    '<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" i="1"/><a:t>Costs flat</a:t></a:r><a:endParaRPr lang="en-US" i="1"/></a:p>' +
    '<a:p><a:r><a:rPr lang="en-US"/><a:t>Hiring &amp; growth</a:t></a:r></a:p>'),
);

const slide2 = slide(
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(838200, 1825625, 3048000, 2286000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
  textBox(5, xfrm(4572000, 1825625, 3810000, 1143000), '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2400"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>Photo </a:t></a:r><a:r><a:rPr lang="en-US" sz="2400" u="sng"/><a:t>caption</a:t></a:r></a:p>'),
);

const slide3 = slide(
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Chart 5"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="1825625"/><a:ext cx="5000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>` +
  `<p:pic><p:nvPicPr><p:cNvPr id="7" name="Video 6"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId3"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId4"/></p:blipFill><p:spPr>${xfrm(6000000, 1825625, 2000000, 1500000)}</p:spPr></p:pic>`,
);

const slide4 = slide(textBox(2, xfrm(838200, 838200, 6000000, 1000000), '<a:p><a:r><a:rPr lang="en-US"/><a:t>Backup slide</a:t></a:r></a:p>'), ' show="0"');

const layout = xml(`<p:sldLayout ${NSDECL} type="obj"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  placeholder(2, "Title 1", '<p:ph type="title"/>', "<a:p><a:endParaRPr/></a:p>", xfrm(838200, 365125, 10515600, 1325563)) +
  placeholder(3, "Content Placeholder 2", '<p:ph idx="1"/>', "<a:p><a:endParaRPr/></a:p>", xfrm(838200, 1825625, 10515600, 4351338)) +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);

const master = xml(`<p:sldMaster ${NSDECL}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  placeholder(2, "Title Placeholder 1", '<p:ph type="title"/>', "<a:p><a:endParaRPr/></a:p>", xfrm(838200, 365125, 10515600, 1325563)) +
  placeholder(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', "<a:p><a:endParaRPr/></a:p>", xfrm(838200, 1825625, 10515600, 4351338)) +
  `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>` +
  `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`);

const theme = xml(`<a:theme xmlns:a="${A}" name="Office Theme"><a:themeElements><a:clrScheme name="Office">` +
  `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>` +
  `<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
  `<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"/></a:themeElements></a:theme>`);

export const NOTES_TEXT = "Mention the hiring plan.";

const notesSlide = xml(`<p:notes ${NSDECL}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
  placeholder(3, "Notes Placeholder 2", '<p:ph type="body" idx="1"/>', `<a:p><a:r><a:rPr lang="en-US"/><a:t>${NOTES_TEXT}</a:t></a:r></a:p>`) +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);

const notesMaster = xml(`<p:notesMaster ${NSDECL}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`);

const chart = xml('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:layout/></c:plotArea></c:chart></c:chartSpace>');

const presentationXml = (extra = "") => xml(`<p:presentation ${NSDECL} saveSubsetFonts="1">` +
  `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId7"/></p:notesMasterIdLst>` +
  `<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/><p:sldId id="259" r:id="rId5"/></p:sldIdLst>` +
  `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>${extra}</p:presentation>`);

/** Parts of the four-slide fixture; `extra` adds or replaces parts. */
export function deckParts(extra: FixtureParts = {}, presentationExtra = ""): FixtureParts {
  return {
    "[Content_Types].xml": contentTypes({
      "ppt/presentation.xml": `${CT}.presentation.main+xml`,
      "ppt/slides/slide1.xml": `${CT}.slide+xml`,
      "ppt/slides/slide2.xml": `${CT}.slide+xml`,
      "ppt/slides/slide3.xml": `${CT}.slide+xml`,
      "ppt/slides/slide4.xml": `${CT}.slide+xml`,
      "ppt/slideLayouts/slideLayout1.xml": `${CT}.slideLayout+xml`,
      "ppt/slideMasters/slideMaster1.xml": `${CT}.slideMaster+xml`,
      "ppt/notesSlides/notesSlide1.xml": `${CT}.notesSlide+xml`,
      "ppt/notesMasters/notesMaster1.xml": `${CT}.notesMaster+xml`,
      "ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
      "ppt/charts/chart1.xml": "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
    }, { png: "image/png", mp4: "video/mp4" }),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]),
    "ppt/presentation.xml": presentationXml(presentationExtra),
    "ppt/_rels/presentation.xml.rels": relationships([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      { id: "rId2", type: "slide", target: "slides/slide1.xml" },
      { id: "rId3", type: "slide", target: "slides/slide2.xml" },
      { id: "rId4", type: "slide", target: "slides/slide3.xml" },
      { id: "rId5", type: "slide", target: "slides/slide4.xml" },
      { id: "rId6", type: "theme", target: "theme/theme1.xml" },
      { id: "rId7", type: "notesMaster", target: "notesMasters/notesMaster1.xml" },
    ]),
    "ppt/slides/slide1.xml": slide1,
    "ppt/slides/_rels/slide1.xml.rels": relationships([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "notesSlide", target: "../notesSlides/notesSlide1.xml" },
    ]),
    "ppt/slides/slide2.xml": slide2,
    "ppt/slides/_rels/slide2.xml.rels": relationships([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "image", target: "../media/image1.png" },
    ]),
    "ppt/slides/slide3.xml": slide3,
    "ppt/slides/_rels/slide3.xml.rels": relationships([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "chart", target: "../charts/chart1.xml" },
      { id: "rId3", type: "video", target: "../media/media1.mp4" },
      { id: "rId4", type: "image", target: "../media/image1.png" },
    ]),
    "ppt/slides/slide4.xml": slide4,
    "ppt/slides/_rels/slide4.xml.rels": relationships([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
    "ppt/slideLayouts/slideLayout1.xml": layout,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
    "ppt/slideMasters/slideMaster1.xml": master,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
    ]),
    "ppt/notesSlides/notesSlide1.xml": notesSlide,
    "ppt/notesSlides/_rels/notesSlide1.xml.rels": relationships([
      { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
      { id: "rId2", type: "slide", target: "../slides/slide1.xml" },
    ]),
    "ppt/notesMasters/notesMaster1.xml": notesMaster,
    "ppt/notesMasters/_rels/notesMaster1.xml.rels": relationships([{ id: "rId1", type: "theme", target: "../theme/theme1.xml" }]),
    "ppt/theme/theme1.xml": theme,
    "ppt/charts/chart1.xml": chart,
    "ppt/media/image1.png": TINY_PNG,
    "ppt/media/media1.mp4": new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
    ...extra,
  };
}

export function buildDeck(extra: FixtureParts = {}, presentationExtra = ""): Uint8Array {
  return buildPackage(deckParts(extra, presentationExtra));
}
