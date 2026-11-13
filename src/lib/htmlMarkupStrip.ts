// Tokenizer-shaped removal of saved-page preview code. Not a sanitizer.

export const FONT_FACE_RULE_RE = /@font-face\s*\{[^{}]*\}/gi;

export function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

const isHtmlSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAsciiAlpha = (c: number) => (c | 32) >= 97 && (c | 32) <= 122;
const isTagNameEnd = (c: number) => isHtmlSpace(c) || c === 47 || c === 62;

interface ScannedAttr { from: number; name: string; valueFrom: number; valueTo: number; to: number }

/** Read attributes from just after a tag name, following the HTML tokenizer's attribute states. */
function scanTagAttributes(html: string, at: number): { end: number; attrs: ScannedAttr[]; selfClosing: boolean } {
  const attrs: ScannedAttr[] = [];
  const n = html.length;
  let i = at;
  for (;;) {
    const from = i;
    while (i < n && (isHtmlSpace(html.charCodeAt(i)) || (html[i] === "/" && html[i + 1] !== ">"))) i++;
    if (i >= n) return { end: n, attrs, selfClosing: false };
    if (html[i] === "/") return { end: i + 2, attrs, selfClosing: true };
    if (html[i] === ">") return { end: i + 1, attrs, selfClosing: false };
    const nameFrom = i++;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (isTagNameEnd(c) || c === 61) break;
      i++;
    }
    const name = html.slice(nameFrom, i).toLowerCase();
    let j = i;
    while (j < n && isHtmlSpace(html.charCodeAt(j))) j++;
    let valueFrom = -1;
    let valueTo = -1;
    if (html[j] === "=") {
      j++;
      while (j < n && isHtmlSpace(html.charCodeAt(j))) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1);
        if (close < 0) return { end: n, attrs, selfClosing: false };
        valueFrom = j + 1;
        valueTo = close;
        i = close + 1;
      } else {
        valueFrom = j;
        while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html[j] !== ">") j++;
        valueTo = i = j;
      }
    }
    attrs.push({ from, name, valueFrom, valueTo, to: i });
  }
}

/** Elements whose content the HTML parser reads as text until the matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
const closeTagPatterns = new Map<string, RegExp>();

function findCloseTag(html: string, name: string, from: number): number {
  let re = closeTagPatterns.get(name);
  if (!re) closeTagPatterns.set(name, re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi"));
  re.lastIndex = from;
  return re.exec(html)?.index ?? -1;
}

/**
 * Remove preview code with one tokenizer-shaped scan. Tags, comments and
 * raw-text bodies are recognized as the HTML parser reads them, so prose and
 * code samples that only look like attributes or CSS stay intact, and a
 * removal cannot join surrounding text into new markup. Not a sanitizer.
 */
export function stripSavedMarkup(html: string, strip: { scripts: boolean; handlers: boolean; fonts: boolean }): string {
  const n = html.length;
  let out = "";
  let copied = 0;
  const replace = (from: number, to: number, text: string) => {
    out += html.slice(copied, from) + text;
    copied = to;
  };
  let foreign = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html.charCodeAt(lt + 1);
    if (next === 33 || next === 63) { // <! and <?
      if (html.startsWith("<!--", lt)) {
        if (html.startsWith("<!-->", lt)) { i = lt + 5; continue; }
        if (html.startsWith("<!--->", lt)) { i = lt + 6; continue; }
        const end = html.indexOf("-->", lt + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (next === 47) { // </
      const first = html.charCodeAt(lt + 2);
      if (isAsciiAlpha(first)) {
        let j = lt + 2;
        while (j < n && !isTagNameEnd(html.charCodeAt(j))) j++;
        const name = html.slice(lt + 2, j).toLowerCase();
        if ((name === "svg" || name === "math") && foreign > 0) foreign--;
        i = scanTagAttributes(html, j).end;
        continue;
      }
      if (first === 62) { i = lt + 3; continue; }
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (!isAsciiAlpha(next)) { i = lt + 1; continue; }
    let j = lt + 1;
    while (j < n && !isTagNameEnd(html.charCodeAt(j))) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const tag = scanTagAttributes(html, j);
    if (strip.scripts && name === "script") {
      const close = findCloseTag(html, "script", tag.end);
      const end = close < 0 ? n : scanTagAttributes(html, close + 8).end;
      // A literal "<" before the removed element must not open a tag with the text after it.
      if (lt > copied ? html[lt - 1] === "<" : out.endsWith("<")) {
        if (lt > copied) replace(lt - 1, lt, "&lt;");
        else out = `${out.slice(0, -1)}&lt;`;
      }
      replace(lt, end, "");
      i = end;
      continue;
    }
    for (const attr of tag.attrs) {
      if (strip.handlers && /^on[a-z0-9_-]+$/.test(attr.name)) {
        // Keep a separator so the neighbouring attribute names cannot merge.
        const after = attr.to < n ? html.charCodeAt(attr.to) : 62;
        replace(attr.from, attr.to, isTagNameEnd(after) ? "" : " ");
      } else if (strip.fonts && attr.name === "style" && attr.valueFrom >= 0) {
        const value = html.slice(attr.valueFrom, attr.valueTo);
        const stripped = value.replace(FONT_FACE_RULE_RE, "");
        if (stripped !== value) replace(attr.valueFrom, attr.valueTo, stripped);
      }
    }
    i = tag.end;
    if (name === "svg" || name === "math") {
      if (!tag.selfClosing) foreign++;
    } else if (name === "plaintext" && foreign === 0) {
      i = n;
    } else if (foreign === 0 && RAW_TEXT_ELEMENTS.has(name)) {
      const close = findCloseTag(html, name, tag.end);
      const contentEnd = close < 0 ? n : close;
      if (strip.fonts && name === "style") {
        const css = html.slice(tag.end, contentEnd);
        const stripped = css.replace(FONT_FACE_RULE_RE, "");
        // Removal can join text into "</style"; escape it so CSS stays inside the element.
        if (stripped !== css) replace(tag.end, contentEnd, escapeStyleText(stripped));
      }
      i = contentEnd;
    }
  }
  return out + html.slice(copied);
}
