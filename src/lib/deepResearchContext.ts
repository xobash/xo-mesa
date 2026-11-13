import type { NoteMeta, VaultFile } from "../types";
import { backlinksFor, makeResolver } from "./graph";
import { truncateUtf8, utf8ByteLength, type DeepResearchLimits } from "./deepResearchConfig";
import type { DeepResearchContext, DeepResearchContextNote, ResearchContextScope } from "./deepResearch";

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export interface BuildContextInput {
  query: string;
  activePath: string | null;
  selectedPaths: string[];
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
  content: Record<string, string>;
  limits: DeepResearchLimits;
  /** Context gathering scope; defaults to `workspace`. */
  scope?: ResearchContextScope;
}

function isHiddenArtifact(rel: string): boolean {
  // Dot-prefixed segment anywhere in the path: `.file.md`, `.folder/note.md`,
  // and `.name.ext.mesa-save-…tmp` write artifacts all stay out of context —
  // they are either Mesa's in-flight write machinery or private/credential
  // material that must never be injected into the model.
  const parts = rel.split("/");
  if (parts.some((seg) => seg.startsWith("."))) return true;
  const base = (parts[parts.length - 1] ?? "").toLowerCase().replace(/\.(?:md|markdown|txt)$/i, "");
  return /^(?:credentials?|secrets?|api[-_ ]?keys?|private[-_ ]?keys?|tokens?|passwords?|auth)$/.test(base);
}

/** Remove credential-shaped values while preserving surrounding note prose. */
export function redactResearchContent(content: string): { content: string; redacted: boolean } {
  let redacted = false;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    content = content.replace(pattern, (...args) => {
      redacted = true;
      return typeof replacement === "string" ? replacement : replacement(...(args as string[]));
    });
  };
  replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    "[REDACTED PRIVATE KEY]"
  );
  replace(
    /^([^\S\r\n\u2028\u2029]*(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|sync[_ -]?key|secret|password|private[_ -]?key)\s*[:=]\s*)(\S.*)$/gim,
    (...args) => `${args[1]}[REDACTED]`
  );
  replace(
    /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
    "[REDACTED CREDENTIAL]"
  );
  replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED CREDENTIAL]"
  );
  return { content, redacted };
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "by", "at", "as", "it", "its", "this",
  "that", "what", "how", "why", "when", "where", "which", "who", "does",
  "do", "did", "from", "about", "into", "over", "under", "between",
]);

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

/** Select active, explicit, and neighbouring notes first; vault scope adds shared-tag and content matches.
 * Exclude hidden paths, deduplicate, cap notes/bytes, and report truncation. */
export function buildResearchContext(input: BuildContextInput): DeepResearchContext {
  const { query, activePath, selectedPaths, notes, content, limits } = input;
  const scope: ResearchContextScope = input.scope ?? "workspace";
  const mdFiles = input.files.filter((f) => f.isMarkdown && !isHiddenArtifact(f.relPath));
  const byRel = new Map(mdFiles.map((f) => [f.relPath, f]));

  const picked = new Map<string, DeepResearchContextNote>();
  const via = (rel: string, why: string) => {
    const cur = picked.get(rel);
    if (cur) {
      if (!cur.via.includes(why)) cur.via.push(why);
    }
  };

  // Notes past the count cap are only counted: the cap below keeps the first
  // `maxContextNotes` in insertion order, so their content is never used.
  const overflow = new Set<string>();
  const add = (rel: string, why: string): boolean => {
    const f = byRel.get(rel);
    const meta = notes[rel];
    if (!f || !meta) return false;
    if (picked.has(rel)) {
      via(rel, why);
      return true;
    }
    if (overflow.has(rel)) return true;
    if (picked.size >= limits.maxContextNotes) {
      overflow.add(rel);
      return true;
    }
    const safe = redactResearchContent(content[rel] ?? "");
    picked.set(rel, {
      relPath: rel,
      title: meta.title,
      tags: meta.tags,
      content: safe.content,
      via: [why],
      redacted: safe.redacted || undefined,
    });
    return true;
  };

  // 1. Active + selected — always first, never dropped.
  if (activePath) add(activePath, "active");
  for (const rel of selectedPaths) add(rel, "selected");

  // 2. Backlinks into the active note, and its outgoing links.
  if (activePath && notes[activePath]) {
    for (const src of backlinksFor(notes, activePath)) add(src, "backlink");
    // One index for every outgoing link — `resolveTarget` would rebuild it per
    // link, which is O(notes) each time on a note that can carry hundreds.
    const resolve = makeResolver(notes);
    for (const raw of notes[activePath].rawLinks) {
      const tgt = resolve(raw);
      if (tgt) add(tgt, "outgoing");
    }
  }

  // Vault scope only: mine the rest of the vault. Workspace scope stops at
  // what the user's surfaces are showing — no whole-vault sweeps.
  if (scope === "vault") {
    // 3. Notes sharing a tag with any already-picked note.
    const pickedTags = new Set<string>();
    for (const n of picked.values()) for (const t of n.tags) pickedTags.add(t);
    for (const rel of overflow) for (const t of notes[rel].tags) pickedTags.add(t);
    if (pickedTags.size) {
      for (const f of mdFiles) {
        const meta = notes[f.relPath];
        if (meta && meta.tags.some((t) => pickedTags.has(t))) add(f.relPath, "tag");
      }
    }

    // 4. Bounded content search over the remaining notes.
    const terms = queryTerms(query);
    if (terms.length) {
      for (const f of mdFiles) {
        if (picked.has(f.relPath) || overflow.has(f.relPath)) continue;
        const text = (content[f.relPath] ?? "").toLowerCase();
        const name = f.name.toLowerCase();
        if (terms.some((t) => text.includes(t) || name.includes(t))) add(f.relPath, "search");
      }
    }
  }

  // Enforce caps deterministically: keep insertion order (active/selected win).
  const all = [...picked.values()];
  const kept: DeepResearchContextNote[] = [];
  let totalBytes = 0;
  let omitted = overflow.size;
  let truncated = overflow.size > 0;
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (i >= limits.maxContextNotes) {
      omitted++;
      truncated = true;
      continue;
    }
    let body = n.content;
    if (utf8ByteLength(body) > limits.maxNoteBytes) {
      body = truncateUtf8(body, limits.maxNoteBytes);
      truncated = true;
    }
    const bodyBytes = utf8ByteLength(body);
    if (totalBytes + bodyBytes > limits.maxTotalBytes) {
      omitted++;
      truncated = true;
      continue;
    }
    totalBytes += bodyBytes;
    kept.push({ ...n, content: body });
  }

  const summary =
    `${kept.length} note${kept.length === 1 ? "" : "s"} in context` +
    (truncated ? ` (${omitted} omitted, ${totalBytes} B, truncated)` : `, ${totalBytes} B`);

  return { query, scope, notes: kept, totalBytes, truncated, omittedNotes: omitted, summary };
}
