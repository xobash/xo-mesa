import { forEachSegment, inlineCodeSpans, isMarkdownPath } from "./markdownCode";
import { extOf, stripExt } from "./vault";
import { linkKey } from "./fsnames";

// A body that stops at a single "]", a newline or the end is consumed as a
// non-link, so repeated "[[" cannot rescan the same line from every start.
const WIKI_LINK_RE = /(!?)\[\[([^\]\n]+)(\]\]|\]|(?=\n)|$)/g;
// Destination: `<with spaces>` or a bare run with balanced parentheses; optional CommonMark title.
const LINK_TAIL_RE = /\((<[^<>\n]+>|(?:\\.|[^\\\s()])+(?:\((?:\\.|[^\\\n()])*\)(?:\\.|[^\\\s()])*)*)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))[ \t]*)?\)/y;
const LABEL_IMAGE_TAIL_RE = /\([^()\s]+\)/y;

type MarkdownLinkReplacer = (match: string, bang: string, label: string, raw: string, title: string | undefined) => string;

/** First "]" or newline at or after `from`, cached so increasing queries stay linear. */
function labelStops(text: string): (from: number) => number {
  let start = -1;
  let stop = -1;
  return (from) => {
    if (from >= start && from <= stop) return stop;
    let i = from;
    while (i < text.length && text[i] !== "]" && text[i] !== "\n") i++;
    start = from;
    stop = i;
    return i;
  };
}

/**
 * Replace inline Markdown links `[label](dest "title")` and images. A label
 * may hold one inline image, as in a badge: `[![alt](img.png)](Note.md)`.
 * This is a linear scan with the same matches as the equivalent regular
 * expression, whose nested lazy label groups were quadratic on runs of "![".
 */
function replaceMarkdownLinks(text: string, replacer: MarkdownLinkReplacer): string {
  const labelStop = labelStops(text);
  const afterImageStop = labelStops(text);
  const tails = new Map<number, RegExpExecArray | null>();
  const tailAt = (at: number) => {
    let tail = tails.get(at);
    if (tail === undefined) {
      LINK_TAIL_RE.lastIndex = at;
      tails.set(at, tail = LINK_TAIL_RE.exec(text));
    }
    return tail;
  };
  // Per label end: the label image's "[" and the "]" that closes the outer label, or -1.
  const images = new Map<number, { open: number; close: number }>();
  let out = "";
  let last = 0;
  for (let s = text.indexOf("["); s >= 0; s = text.indexOf("[", s + 1)) {
    const e1 = labelStop(s + 1);
    if (text[e1] !== "]") continue;
    let image = images.get(e1);
    if (!image) {
      const open = text.lastIndexOf("[", e1 - 1);
      let close = -1;
      LABEL_IMAGE_TAIL_RE.lastIndex = e1 + 1;
      if (open > 0 && text[open - 1] === "!" && LABEL_IMAGE_TAIL_RE.test(text)) {
        const e2 = afterImageStop(LABEL_IMAGE_TAIL_RE.lastIndex);
        if (text[e2] === "]") close = e2;
      }
      images.set(e1, image = { open, close });
    }
    let labelEnd = -1;
    let tail: RegExpExecArray | null = null;
    if (image.close >= 0 && image.open - 1 > s) {
      tail = tailAt(image.close + 1);
      if (tail) labelEnd = image.close;
    }
    if (!tail) {
      tail = tailAt(e1 + 1);
      labelEnd = e1;
    }
    if (!tail) continue;
    const bang = s - 1 >= last && text[s - 1] === "!" ? "!" : "";
    const start = s - bang.length;
    const end = tail.index + tail[0].length;
    out += text.slice(last, start) + replacer(text.slice(start, end), bang, text.slice(s + 1, labelEnd), tail[1], tail[2]);
    last = end;
    s = end - 1;
  }
  return last ? out + text.slice(last) : text;
}
/** Percent-encode the characters a bare Markdown destination cannot hold literally. */
const encodeDestination = (path: string) => path
  .replace(/%/g, "%25").replace(/#/g, "%23").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
/** Stands in for an inline code span (a private-use character); resolves to no file, so no rewrite touches it. */
const PLACEHOLDER = "\uE000";
const PLACEHOLDER_RE = /\uE000(\d+)\uE000/g;
const REFERENCE_DEFINITION_RE = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]+>|[^\s]+)(.*)$/gm;

/**
 * Apply a link rewrite only to Markdown prose. Regexes are useful for the
 * link token itself, but not for deciding where a token is meaningful: a
 * literal example in code must never be "repaired". Code lines pass through
 * unchanged. Each paragraph is rewritten as one text with its inline code
 * spans (which may cross lines) held as placeholders, so a link whose label
 * holds code (``[`a.md`](a.md)``) is still one link. Other text files have
 * fenced blocks as their only code lines, and inline spans per line.
 */
function rewriteMarkdownProse(
  content: string,
  markdown: boolean,
  rewriteText: (text: string) => string
): string {
  const out: string[] = [];
  forEachSegment(content, (start, end, code) => {
    const text = content.slice(start, end);
    const spans = code ? [] : inlineCodeSpans(text);
    // A placeholder character already in the text would be ambiguous; leave it as written.
    if (code || (spans.length && text.includes(PLACEHOLDER))) return out.push(text);
    if (!spans.length) return out.push(rewriteText(text));
    const held: string[] = [];
    let masked = "";
    let at = 0;
    for (let k = 0; k < spans.length; k += 2) {
      masked += `${text.slice(at, spans[k])}${PLACEHOLDER}${held.length}${PLACEHOLDER}`;
      held.push(text.slice(spans[k], spans[k + 1]));
      at = spans[k + 1];
    }
    out.push(rewriteText(masked + text.slice(at)).replace(PLACEHOLDER_RE, (_, n: string) => held[Number(n)]));
  }, markdown);
  return out.join("\n");
}

export function rewriteInboundLinks(
  sourceRel: string,
  content: string,
  oldRel: string,
  newRel: string,
  resolveNote: (target: string) => string | null,
  renamedIsMarkdown: boolean,
  bareNameUnambiguous: boolean
): { text: string; changed: boolean } {
  const sourceDir = sourceRel.includes("/") ? sourceRel.slice(0, sourceRel.lastIndexOf("/")) : "";
  const oldBase = linkKey(oldRel.slice(oldRel.lastIndexOf("/") + 1));
  const oldExt = `.${extOf(oldRel)}`;
  // A wikilink that names the file (not a frontmatter alias) breaks on rename.
  const namesOldFile = (target: string) => {
    const path = linkKey(normalizeRelativeTarget(sourceDir, target).replace(/^\/+/, ""));
    const bare = path.endsWith(oldExt) ? path.slice(0, -oldExt.length) : path;
    return bare.slice(bare.lastIndexOf("/") + 1) === stripExt(oldBase);
  };
  const resolve = (target: string) => {
    const normalized = normalizeRelativeTarget(sourceDir, target);
    if (renamedIsMarkdown && (
      resolveNote(target) === oldRel ||
      resolveNote(normalized) === oldRel
    )) return true;
    // Attachments do not participate in the note resolver. Match an exact
    // vault-relative path, or an exact filename where the reference was bare;
    // never guess among duplicate basenames in different folders.
    const targetLower = linkKey(target.replace(/\\/g, "/"));
    const normalizedLower = linkKey(normalized);
    return normalizedLower === linkKey(oldRel) ||
      (bareNameUnambiguous && !targetLower.includes("/") && targetLower === oldBase);
  };
  const replacementTarget = (rawTarget: string): string => {
    const slashy = rawTarget.replace(/\\/g, "/");
    // Only the renamed note's own extension counts: `v1.2 notes` has none.
    const hadExt = renamedIsMarkdown
      ? linkKey(slashy).endsWith(oldExt)
      : /\.[^/]+$/.test(slashy);
    const hadDir = slashy.includes("/");
    // Mesa resolves a path from the vault root before a relative one, and
    // never resolves `../`; keep the form that actually matched.
    const lower = linkKey(slashy);
    const vaultPath = lower === linkKey(oldRel) ||
      (renamedIsMarkdown && !hadExt && lower === linkKey(stripExt(oldRel)));
    const relative = hadDir && !vaultPath ? relativeTargetFrom(sourceDir, newRel) : "";
    const nextRel =
      slashy.startsWith("/") ? `/${newRel}`
        : relative ? (slashy.startsWith("./") && !relative.startsWith("../") ? `./${relative}` : relative)
          : newRel;
    if (hadDir) return hadExt || !renamedIsMarkdown ? nextRel : stripExt(nextRel);
    const base = nextRel.slice(nextRel.lastIndexOf("/") + 1);
    // A bare name that already belongs to another note would resolve there.
    const owner = renamedIsMarkdown ? resolveNote(stripExt(base)) : null;
    if (owner && owner !== oldRel) return hadExt ? newRel : stripExt(newRel);
    return hadExt || !renamedIsMarkdown ? base : stripExt(base);
  };
  let changed = false;
  const text = rewriteMarkdownProse(content, isMarkdownPath(sourceRel), (prose) => replaceMarkdownLinks(prose
    .replace(WIKI_LINK_RE, (match, bang: string, body: string, close: string) => {
      if (close !== "]]") return match;
      // Inside tables the alias separator is written `\|`; keep that escape.
      let pipe = body.indexOf("|");
      if (pipe > 0 && body[pipe - 1] === "\\") pipe--;
      const targetAndHeading = pipe >= 0 ? body.slice(0, pipe) : body;
      const alias = pipe >= 0 ? body.slice(pipe) : "";
      const hash = targetAndHeading.indexOf("#");
      const target = (hash >= 0 ? targetAndHeading.slice(0, hash) : targetAndHeading).trim();
      const heading = hash >= 0 ? targetAndHeading.slice(hash) : "";
      if (!target || !resolve(target)) return match;
      if (renamedIsMarkdown && !namesOldFile(target)) return match;
      changed = true;
      // A wiki embed of a Markdown note is still a note reference and must
      // follow the renamed file. Image/file embeds never resolve through the
      // note resolver, so they remain byte-for-byte unchanged.
      return `${bang}[[${replacementTarget(target)}${heading}${alias}]]`;
    }), function rewriteLink(_match: string, bang: string, label: string, raw: string, title: string | undefined): string {
      // The label's own image follows a renamed attachment independently.
      label = label.includes("](") ? replaceMarkdownLinks(label, rewriteLink) : label;
      const unchanged = `${bang}[${label}](${raw}${title ?? ""})`;
      const angle = raw.startsWith("<");
      const destination = angle ? raw.slice(1, -1) : raw;
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(destination)) return unchanged;
      const rawTarget = destination.replace(/\\([()\\])/g, "$1");
      // Split the heading before decoding, so an encoded `%23` stays in the name.
      const hash = rawTarget.indexOf("#");
      const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
      const target = decode(hash >= 0 ? rawTarget.slice(0, hash) : rawTarget).trim();
      const heading = hash >= 0 ? rawTarget.slice(hash) : "";
      if (!target || !resolve(target)) return unchanged;
      changed = true;
      const nextTarget = replacementTarget(target);
      const dest = angle ? `<${nextTarget}${heading}>` : `${encodeDestination(nextTarget)}${heading}`;
      return `${bang}[${label}](${dest}${title ?? ""})`;
    })
    // Reference-style uses retain their destination in a separate definition;
    // rewriting that definition repairs every `[label]` / `[text][label]` use
    // without touching labels or title text.
    .replace(REFERENCE_DEFINITION_RE, (match, prefix: string, destination: string, suffix: string) => {
      const bracketed = destination.startsWith("<") && destination.endsWith(">");
      const rawTarget = (bracketed ? destination.slice(1, -1) : destination).replace(/\\([()\\])/g, "$1");
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(rawTarget)) return match;
      let decoded = rawTarget;
      try { decoded = decodeURIComponent(rawTarget); } catch { /* keep raw */ }
      const hash = decoded.indexOf("#");
      const target = (hash >= 0 ? decoded.slice(0, hash) : decoded).trim();
      const heading = hash >= 0 ? decoded.slice(hash) : "";
      if (!target || !resolve(target)) return match;
      changed = true;
      const encoded = encodeDestination(replacementTarget(target)) + heading
        .replace(/ /g, "%20")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29");
      return `${prefix}${bracketed ? `<${encoded}>` : encoded}${suffix}`;
    }));
  return { text, changed };
}

export function normalizeRelativeTarget(sourceDir: string, target: string): string {
  const slashy = target.replace(/\\/g, "/");
  if (!slashy.startsWith("./") && !slashy.startsWith("../")) return slashy;
  const parts = [...(sourceDir ? sourceDir.split("/") : []), ...slashy.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Cheap index-time candidate check before rename opens a Markdown source. */
export function referenceMayTarget(
  sourceRel: string,
  rawReference: string,
  oldRel: string,
  bareNameUnambiguous: boolean
): boolean {
  const sourceDir = sourceRel.includes("/") ? sourceRel.slice(0, sourceRel.lastIndexOf("/")) : "";
  let target = rawReference.split("|")[0]?.split("#")[0]?.trim() ?? "";
  try { target = decodeURIComponent(target); } catch { /* malformed escapes stay literal */ }
  if (!target) return false;
  const normalized = linkKey(normalizeRelativeTarget(sourceDir, target));
  if (normalized === linkKey(oldRel)) return true;
  const oldBase = linkKey(oldRel.slice(oldRel.lastIndexOf("/") + 1));
  return bareNameUnambiguous && !target.includes("/") && linkKey(target) === oldBase;
}

function relativeTargetFrom(sourceDir: string, targetRel: string): string {
  const from = sourceDir ? sourceDir.split("/") : [];
  const to = targetRel.split("/");
  const file = to.pop() ?? "";
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  const ups = from.slice(shared).map(() => "..");
  const downs = to.slice(shared);
  const rel = [...ups, ...downs, file].join("/");
  return rel || file;
}
