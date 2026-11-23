import { nextTag } from "./xmlScan";

// Well-formedness check for XML that Mesa wrote (XML 1.0, section 2.1): one
// root, balanced tags, quoted unique attributes, valid references. Linear,
// with an explicit element stack instead of recursion.

const MAX_DEPTH = 10_000;
const BAD_REFERENCE = /&(?!(?:#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z_][\w.-]*);)/;
const SPACE = /\s/;

function stripSkipped(text: string): string {
  return text.includes("<") ? text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, "") : text;
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && SPACE.test(text[i])) i++;
  return i;
}

function attributeProblem(attrs: string): string | null {
  const seen = new Set<string>();
  let i = 0;
  for (let guard = 0; guard <= attrs.length && i < attrs.length; guard++) {
    const before = i;
    i = skipSpace(attrs, i);
    if (i >= attrs.length) return null;
    if (i === before) return "attributes must be separated by white space";
    const nameStart = i;
    while (i < attrs.length && /[^\s=/>"']/.test(attrs[i])) i++;
    const name = attrs.slice(nameStart, i);
    i = skipSpace(attrs, i);
    if (!name || attrs[i] !== "=") return `attribute ${name || "(unnamed)"} has no value`;
    i = skipSpace(attrs, i + 1);
    const quote = attrs[i];
    if (quote !== '"' && quote !== "'") return `attribute ${name} is not quoted`;
    const close = attrs.indexOf(quote, i + 1);
    if (close < 0) return `attribute ${name} is not closed`;
    const value = attrs.slice(i + 1, close);
    if (value.includes("<") || BAD_REFERENCE.test(value)) return `attribute ${name} has an invalid character or reference`;
    if (seen.has(name)) return `attribute ${name} appears twice`;
    seen.add(name);
    i = close + 1;
  }
  return null;
}

/** First well-formedness problem in `xml`, or `null`. */
export function xmlWellFormedProblem(xml: string): string | null {
  const stack: string[] = [];
  let rootSeen = false;
  let at = 0;
  try {
    for (let guard = 0; guard <= xml.length; guard++) {
      const tag = nextTag(xml, at);
      const text = stripSkipped(xml.slice(at, tag ? tag.start : xml.length));
      if (BAD_REFERENCE.test(text) || text.includes("<")) return "text contains an invalid reference or markup";
      if (!stack.length && text.trim()) return "text appears outside the root element";
      if (!tag) break;
      at = tag.end;
      if (tag.kind === "end") {
        if (stack.pop() !== tag.qname) return `end tag ${tag.qname} does not match`;
        continue;
      }
      if (!stack.length && rootSeen) return "the part has more than one root element";
      rootSeen = true;
      const problem = attributeProblem(xml.slice(tag.attrStart, tag.attrEnd));
      if (problem) return `<${tag.qname}>: ${problem}`;
      if (tag.kind === "start") {
        if (stack.length >= MAX_DEPTH) return "elements are nested too deeply";
        stack.push(tag.qname);
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (stack.length) return `element ${stack[stack.length - 1]} is not closed`;
  return rootSeen ? null : "the part has no root element";
}
