import { decodeXmlText, escapeXmlText } from "./xmlScan";

// SpreadsheetML text: entity decoding plus the `_xHHHH_` escape that Office
// uses for characters XML 1.0 cannot carry (ECMA-376 Part 1, 22.9.2.19
// ST_Xstring). Rich-text runs are joined; phonetic runs (`rPh`) are skipped.

/** XML-decoded text with `_xHHHH_` escapes resolved. */
export function decodeSpreadsheetText(raw: string): string {
  const text = decodeXmlText(raw);
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Element-body text for a cell string: escapes literal `_xHHHH_`, control characters and CR. */
export function encodeSpreadsheetText(text: string): string {
  const escaped = text
    .replace(/_x(?=[0-9A-Fa-f]{4}_)/g, "_x005F_x")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f￾￿]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`);
  return escapeXmlText(escaped);
}

/** True when `ch` may follow an element name in a tag. */
export function isNameBoundary(ch: string | undefined): boolean {
  return ch === " " || ch === ">" || ch === "/" || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Next `<{qname}` start or empty tag at or after `from` and before `to`, or -1. */
export function findElement(xml: string, qname: string, from: number, to: number): number {
  const needle = `<${qname}`;
  // Search only inside [from, to): an unbounded indexOf would scan the rest of
  // a large sheet for every cell that lacks the element.
  const window = xml.slice(from, to);
  let at = 0;
  for (let guard = 0; guard <= to - from; guard++) {
    const local = window.indexOf(needle, at);
    if (local < 0) return -1;
    const found = from + local;
    if (isNameBoundary(xml[found + needle.length])) return found;
    at = local + needle.length;
  }
  return -1;
}

/**
 * Joined text of the `<t>` elements in `xml[from, to)`, skipping phonetic
 * `<rPh>` runs. `pfx` is the SpreadsheetML prefix with its colon, or "".
 */
export function richText(xml: string, from: number, to: number, pfx: string): string {
  let out = "";
  let at = from;
  for (let guard = 0; guard <= to - from && at < to; guard++) {
    const t = findElement(xml, `${pfx}t`, at, to);
    if (t < 0) break;
    const phonetic = findElement(xml, `${pfx}rPh`, at, t);
    if (phonetic >= 0) {
      const close = xml.indexOf(`</${pfx}rPh>`, phonetic);
      at = close < 0 ? to : close + pfx.length + 6;
      continue;
    }
    const open = xml.indexOf(">", t);
    if (open < 0 || open >= to) break;
    if (xml[open - 1] === "/") { at = open + 1; continue; }
    const close = xml.indexOf(`</${pfx}t>`, open);
    if (close < 0 || close > to) break;
    out += xml.slice(open + 1, close);
    at = close + pfx.length + 4;
  }
  return decodeSpreadsheetText(out);
}

/** Shared-string table (18.4.9) as plain strings, in one linear pass. */
export function parseSharedStrings(xml: string, pfx: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (let guard = 0; guard <= xml.length; guard++) {
    const si = findElement(xml, `${pfx}si`, at, xml.length);
    if (si < 0) break;
    const open = xml.indexOf(">", si);
    if (open < 0) break;
    if (xml[open - 1] === "/") { out.push(""); at = open + 1; continue; }
    const close = xml.indexOf(`</${pfx}si>`, open);
    if (close < 0) break;
    out.push(richText(xml, open + 1, close, pfx));
    at = close + pfx.length + 5;
  }
  return out;
}
