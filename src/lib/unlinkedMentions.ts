import { proseText } from "./markdownCode";
import type { NoteMeta } from "../types";

/** One plain-text occurrence of a note's title or alias in another note. */
export interface UnlinkedMention {
  start: number;
  end: number;
  /** The exact source text at [start, end). */
  text: string;
  before: string;
  after: string;
}

/** Title and aliases worth matching, longest first so "New York City" wins over "New York". */
export function mentionNames(meta: Pick<NoteMeta, "title" | "aliases">): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of [meta.title, ...meta.aliases]) {
    const name = raw.trim();
    const key = name.toLocaleLowerCase();
    // One character matches nearly every note; it is never a useful mention.
    if ([...name].length < 2 || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.sort((a, b) => b.length - a.length);
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");
// Places where a title is already a link, a URL or markup rather than prose.
const NOT_PROSE = [
  /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, // frontmatter
  /!?\[\[[^\]\n]*\]\]/g, // wiki links and embeds
  /!?\[[^\]\n]*\]\([^)\n]*\)/g, // Markdown links and images
  /!?\[[^\]\n]*\]\[[^\]\n]*\]/g, // reference links
  /\[\^[^\]\n]*\]/g, // footnote references
  /(?<![\p{L}\p{N}_&/])#[\p{L}\p{N}_/-]+/gu, // tags
  /^\s{0,3}\[[^\]\n]+\]:.*$/gm, // reference definitions
  /<[^>\n]+>/g, // HTML tags and autolinks
  /\b(?:https?|mailto|file):[^\s)>\]]+/gi, // bare URLs
  /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, // math
];

/** `source` with code, links, URLs, markup and frontmatter blanked out.
 * Offsets and line breaks are kept, so matches index the original text. */
export function mentionableText(source: string): string {
  let text = proseText(source, true);
  for (const pattern of NOT_PROSE) text = text.replace(pattern, blank);
  return text;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find unlinked, whole-word, case-insensitive mentions of `names` in prose. */
export function findUnlinkedMentions(source: string, names: readonly string[], limit = 50): UnlinkedMention[] {
  if (!names.length || !source) return [];
  const lower = source.toLocaleLowerCase();
  // Cheap reject before the full scan: most notes mention none of the names.
  if (!names.some((name) => lower.includes(name.toLocaleLowerCase()))) return [];
  const prose = mentionableText(source);
  const found: UnlinkedMention[] = [];
  const taken: Array<[number, number]> = [];
  for (const name of names) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "giu");
    for (const match of prose.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = source.indexOf("\n", end);
      const before = source.slice(Math.max(lineStart, start - 60), start);
      const after = source.slice(end, Math.min(lineEnd < 0 ? source.length : lineEnd, end + 60));
      found.push({ start, end, text: source.slice(start, end), before, after });
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
  }
  return found.sort((a, b) => a.start - b.start);
}

// Characters that end or redirect a wiki-link target (heading, alias, block).
const LINK_SYNTAX = /[#|^[\]]/;

/** Wiki link text that resolves to `targetRel`: the title when it resolves
 * there, otherwise the extension-free vault path; null when neither can be
 * written as a plain link target. */
export function linkTextFor(
  targetRel: string,
  title: string,
  resolve: (target: string) => string | null
): string | null {
  if (!LINK_SYNTAX.test(title) && resolve(title) === targetRel) return title;
  const path = targetRel.replace(/\.md$/i, "");
  return LINK_SYNTAX.test(path) ? null : path;
}

/** Replace one mention with a wiki link. Returns null when the text at the
 * mention's offsets has changed since it was found, so a stale click never
 * rewrites the wrong words. */
export function linkMention(source: string, mention: Pick<UnlinkedMention, "start" | "end" | "text">, linkText: string): string | null {
  if (source.slice(mention.start, mention.end) !== mention.text) return null;
  const aliased = mention.text !== linkText;
  if (aliased) {
    const lineStart = source.lastIndexOf("\n", mention.start - 1) + 1;
    const lineEnd = source.indexOf("\n", mention.end);
    // The alias pipe would split a table cell, and wiki links cannot escape it.
    if (source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).includes("|")) {
      throw new Error("This mention is in a table row; link it by hand with the exact note title.");
    }
  }
  const link = aliased ? `[[${linkText}|${mention.text}]]` : `[[${linkText}]]`;
  return source.slice(0, mention.start) + link + source.slice(mention.end);
}

export interface MentionScanResult { relPath: string; mentions: UnlinkedMention[] }

/** Resumable scan over candidate notes, so a large vault yields to input.
 * `read` returns undefined for a note whose text is not indexed yet. */
export function createMentionScan(
  rels: readonly string[],
  read: (relPath: string) => string | undefined,
  names: readonly string[],
  now: () => number = () => performance.now()
) {
  let index = 0, unread = 0;
  const results: MentionScanResult[] = [];
  return {
    /** Scan for up to `budgetMs` (at least one note). True when complete. */
    advance(budgetMs: number): boolean {
      const started = now();
      do {
        if (index >= rels.length) return true;
        const relPath = rels[index++];
        const text = read(relPath);
        if (text === undefined) { unread++; continue; }
        const mentions = findUnlinkedMentions(text, names);
        if (mentions.length) results.push({ relPath, mentions });
      } while (now() - started < budgetMs);
      return index >= rels.length;
    },
    results: () => results,
    unread: () => unread,
  };
}
