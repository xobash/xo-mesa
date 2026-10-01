import { stripExt } from "./vault";

const WIKI_LINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*?)\]\(((?:\\.|[^\\\s()])+(?:\((?:\\.|[^\\\n()])*\)(?:\\.|[^\\\s()])*)*)\)/g;
const REFERENCE_DEFINITION_RE = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]+>|[^\s]+)(.*)$/gm;

/**
 * Apply a link rewrite only to Markdown prose. Regexes are useful for the
 * link token itself, but not for deciding where a token is meaningful: a
 * literal example in a fenced or inline code span must never be "repaired".
 * The complete fence delimiter is retained: a four-backtick fence may contain
 * ordinary three-backtick examples without ending the protected range.
 */
function rewriteMarkdownProse(
  content: string,
  rewriteLine: (line: string) => string
): string {
  let fence: string | null = null;
  return content
    .split(/(\n)/)
    .map((part) => {
      if (part === "\n") return part;
      const opening = part.match(/^\s*(`{3,}|~{3,})/);
      if (opening) {
        const marker = opening[1];
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return part;
      }
      if (fence) return part;

      // Keep every inline code span byte-for-byte. Matching the delimiter run
      // (rather than a single backtick) also handles Markdown's ``code ` x``.
      let out = "";
      let cursor = 0;
      while (cursor < part.length) {
        const start = part.indexOf("`", cursor);
        if (start < 0) return out + rewriteLine(part.slice(cursor));
        out += rewriteLine(part.slice(cursor, start));
        let endRun = start;
        while (part[endRun] === "`") endRun++;
        const delimiter = part.slice(start, endRun);
        const close = part.indexOf(delimiter, endRun);
        if (close < 0) return out + part.slice(start);
        out += part.slice(start, close + delimiter.length);
        cursor = close + delimiter.length;
      }
      return out;
    })
    .join("");
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
  const oldBase = oldRel.slice(oldRel.lastIndexOf("/") + 1).toLowerCase();
  const resolve = (target: string) => {
    const normalized = normalizeRelativeTarget(sourceDir, target);
    if (renamedIsMarkdown && (
      resolveNote(target) === oldRel ||
      resolveNote(normalized) === oldRel
    )) return true;
    // Attachments do not participate in the note resolver. Match an exact
    // vault-relative path, or an exact filename where the reference was bare;
    // never guess among duplicate basenames in different folders.
    const targetLower = target.replace(/\\/g, "/").toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    return normalizedLower === oldRel.toLowerCase() ||
      (bareNameUnambiguous && !targetLower.includes("/") && targetLower === oldBase);
  };
  const replacementTarget = (rawTarget: string): string => {
    const slashy = rawTarget.replace(/\\/g, "/");
    const hadExt = /\.[^/]+$/.test(slashy.split("#")[0] ?? "");
    const hadDir = slashy.includes("/");
    const nextRel =
      hadDir && !slashy.startsWith("/")
        ? relativeTargetFrom(sourceDir, newRel)
        : newRel;
    if (hadDir) return hadExt || !renamedIsMarkdown ? nextRel : stripExt(nextRel);
    const base = nextRel.slice(nextRel.lastIndexOf("/") + 1);
    return hadExt || !renamedIsMarkdown ? base : stripExt(base);
  };
  let changed = false;
  const text = rewriteMarkdownProse(content, (prose) => prose
    .replace(WIKI_LINK_RE, (match, bang: string, body: string) => {
      const pipe = body.indexOf("|");
      const targetAndHeading = pipe >= 0 ? body.slice(0, pipe) : body;
      const alias = pipe >= 0 ? body.slice(pipe) : "";
      const hash = targetAndHeading.indexOf("#");
      const target = (hash >= 0 ? targetAndHeading.slice(0, hash) : targetAndHeading).trim();
      const heading = hash >= 0 ? targetAndHeading.slice(hash) : "";
      if (!target || !resolve(target)) return match;
      changed = true;
      // A wiki embed of a Markdown note is still a note reference and must
      // follow the renamed file. Image/file embeds never resolve through the
      // note resolver, so they remain byte-for-byte unchanged.
      return `${bang}[[${replacementTarget(target)}${heading}${alias}]]`;
    })
    .replace(MARKDOWN_LINK_RE, (match, bang: string, label: string, raw: string) => {
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(raw)) return match;
      const rawTarget = raw.replace(/\\([()\\])/g, "$1");
      let decoded = rawTarget;
      try {
        decoded = decodeURIComponent(rawTarget);
      } catch {
        /* keep raw */
      }
      const hash = decoded.indexOf("#");
      const target = (hash >= 0 ? decoded.slice(0, hash) : decoded).trim();
      const heading = hash >= 0 ? decoded.slice(hash) : "";
      if (!target || !resolve(target)) return match;
      changed = true;
      const nextTarget = replacementTarget(target) + heading;
      const encoded = nextTarget
        .replace(/ /g, "%20")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29");
      return `${bang}[${label}](${encoded})`;
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
      const encoded = (replacementTarget(target) + heading)
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
  const normalized = normalizeRelativeTarget(sourceDir, target).toLowerCase();
  if (normalized === oldRel.toLowerCase()) return true;
  const oldBase = oldRel.slice(oldRel.lastIndexOf("/") + 1).toLowerCase();
  return bareNameUnambiguous && !target.includes("/") && target.toLowerCase() === oldBase;
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
