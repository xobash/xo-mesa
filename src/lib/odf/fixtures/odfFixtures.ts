import { buildPackage, type FixtureParts } from "../../ooxml/fixtures/ooxmlFixtures";

// Hand-made OpenDocument fixtures for tests, zipped by fflate (never by the
// code under test): `mimetype` first and stored, a manifest listing every
// entry, and small content, styles and meta parts.

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
].join(" ");

const MIME = {
  text: "application/vnd.oasis.opendocument.text",
  spreadsheet: "application/vnd.oasis.opendocument.spreadsheet",
  presentation: "application/vnd.oasis.opendocument.presentation",
} as const;

export type FixtureKind = keyof typeof MIME;

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;

export function contentXml(kind: FixtureKind, body: string, automatic = ""): string {
  return xml(`<office:document-content ${NS} office:version="1.3"><office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`);
}

export function manifestXml(mime: string, paths: readonly string[], encrypted: readonly string[] = []): string {
  const entries = paths.map((p) => `<manifest:file-entry manifest:full-path="${p.replace(/&/g, "&amp;")}" manifest:media-type="${p.endsWith(".xml") ? "text/xml" : ""}"${encrypted.includes(p) ? `><manifest:encryption-data manifest:checksum="x"/></manifest:file-entry>` : "/>"}`).join("");
  return xml(`<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>${entries}</manifest:manifest>`);
}

export const STYLES_XML = xml(`<office:document-styles ${NS}><office:styles><style:style style:name="Strong" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:styles><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`);
const META_XML = xml('<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:meta/></office:document-meta>');

export interface OdfFixtureOptions {
  readonly mime?: string;
  readonly extra?: FixtureParts;
  readonly encrypted?: readonly string[];
  /** Entries left out of the manifest. */
  readonly unlisted?: readonly string[];
  /** Compress the mimetype entry (invalid ODF layout). */
  readonly deflateMimetype?: boolean;
}

/** An OpenDocument package with the given content.xml. */
export function buildOdf(kind: FixtureKind, content: string, options: OdfFixtureOptions = {}): Uint8Array {
  const mime = options.mime ?? MIME[kind];
  const parts: FixtureParts = { "content.xml": content, "styles.xml": STYLES_XML, "meta.xml": META_XML, ...options.extra };
  const listed = Object.keys(parts).filter((p) => !p.startsWith("META-INF/") && !options.unlisted?.includes(p));
  return buildPackage({ mimetype: mime, ...parts, "META-INF/manifest.xml": manifestXml(mime, listed, options.encrypted) },
    { stored: options.deflateMimetype ? [] : ["mimetype"] });
}

export const AUTO_STYLES = '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>';

export const ODT_BODY = [
  '<text:h text:outline-level="1">Report title</text:h>',
  '<text:p>Plain <text:span text:style-name="T1">italic words</text:span> end.<text:bookmark text:name="b1"/></text:p>',
  '<text:list><text:list-item><text:p>First item</text:p></text:list-item><text:list-item><text:p>Second item</text:p></text:list-item></text:list>',
  '<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell></table:table-row></table:table>',
  '<text:p>Visit <text:a xlink:href="https://example.invalid">the site</text:a>.</text:p>',
  '<text:p>Two<text:s text:c="2"/>spaces</text:p>',
].join("");

export function buildOdt(body = ODT_BODY, options: OdfFixtureOptions = {}): Uint8Array {
  return buildOdf("text", contentXml("text", body, AUTO_STYLES), options);
}

export const ODS_BODY = '<table:table table:name="Sheet1"><table:table-column table:number-columns-repeated="1024"/>'
  + '<table:table-row><table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell><table:table-cell table:formula="of:=[.B1]*2" office:value-type="float" office:value="6"><text:p>6</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1021"/></table:table-row>'
  + '<table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
  + '</table:table><table:table table:name="Second"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:number-columns-spanned="2" office:value-type="string"><text:p>Merged</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table>';

export function buildOds(body = ODS_BODY, options: OdfFixtureOptions = {}): Uint8Array {
  return buildOdf("spreadsheet", contentXml("spreadsheet", body), options);
}

export const ODP_BODY = [
  '<draw:page draw:name="page1" draw:master-page-name="Default">',
  '<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Welcome deck</text:p></draw:text-box></draw:frame>',
  '<draw:frame presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="8cm"><draw:text-box><text:list><text:list-item><text:p>Point one</text:p></text:list-item><text:list-item><text:p>Point two</text:p></text:list-item></text:list></draw:text-box></draw:frame>',
  '<presentation:notes><draw:frame presentation:class="notes" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="5cm"><draw:text-box><text:p>Speak slowly</text:p></draw:text-box></draw:frame></presentation:notes>',
  '</draw:page>',
  '<draw:page draw:name="page2" draw:master-page-name="Default"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><draw:image xlink:href="Pictures/p.png"/></draw:frame><draw:custom-shape svg:x="6cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><text:p>Shape text</text:p></draw:custom-shape></draw:page>',
].join("");

export function buildOdp(body = ODP_BODY, options: OdfFixtureOptions = {}): Uint8Array {
  return buildOdf("presentation", contentXml("presentation", body), options);
}
