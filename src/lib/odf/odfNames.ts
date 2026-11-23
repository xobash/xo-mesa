import { nsAttr, nsAttrName, type XmlEl } from "../pptx/xmlTree";

// OpenDocument namespace URIs (ODF 1.3 Part 3, section 2.2) and lookups that
// match an element or attribute by namespace, whatever prefix a file binds.

export const ODF_NS = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
  presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
  xlink: "http://www.w3.org/1999/xlink",
} as const;

export type OdfNs = keyof typeof ODF_NS;

const SETS = Object.fromEntries(Object.entries(ODF_NS).map(([k, v]) => [k, new Set<string>([v])])) as unknown as Record<OdfNs, ReadonlySet<string>>;

export function isOdf(el: XmlEl | null | undefined, ns: OdfNs, local: string): boolean {
  return !!el && el.localName === local && el.ns === ODF_NS[ns];
}

/** Decoded attribute value in an ODF namespace, or `null`. */
export function odfAttr(el: XmlEl | null | undefined, ns: OdfNs, local: string): string | null {
  return nsAttr(el, SETS[ns], local);
}

/** The qualified name this element uses for an ODF attribute, or `null`. */
export function odfAttrName(el: XmlEl, ns: OdfNs, local: string): string | null {
  return nsAttrName(el, SETS[ns], local);
}

/** Positive integer attribute (e.g. a repeat count), clamped to `max`. */
export function odfCount(el: XmlEl, ns: OdfNs, local: string, max: number): number {
  const raw = odfAttr(el, ns, local);
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return 1;
  return Math.max(1, Math.min(max, Number(raw)));
}

/** The prefix the document root binds to an ODF namespace, or `null`. */
export function rootPrefix(root: XmlEl, ns: OdfNs): string | null {
  for (const [prefix, uri] of root.nsMap) if (uri === ODF_NS[ns] && prefix) return prefix;
  return null;
}

/** The prefix of an element's qualified name. */
export function prefixOfEl(el: XmlEl): string {
  const colon = el.name.indexOf(":");
  return colon < 0 ? "" : el.name.slice(0, colon);
}

/** ODF lengths ("2.5cm", "12pt", "1in") to EMU; `null` when unreadable. */
export function lengthToEmu(raw: string | null): number | null {
  const match = raw ? /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(cm|mm|in|pt|pc|px)?\s*$/i.exec(raw) : null;
  if (!match) return null;
  const per: Record<string, number> = { cm: 360000, mm: 36000, in: 914400, pt: 12700, pc: 152400, px: 9525 };
  return Math.round(Number(match[1]) * per[(match[2] ?? "cm").toLowerCase()]);
}
