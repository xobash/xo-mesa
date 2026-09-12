import type { VaultFile, NoteMeta, GraphNode, GraphLink } from "../types";
import {
  extractLinks,
  extractLinksAndFirstImage,
  extractTags,
  extractAliases,
} from "./markdownExtract";
import { isTextualVaultFile } from "./vault";

/** Shared lazy image lookup for parsed and persisted note metadata. */
export function createImageResolver(files: readonly VaultFile[]): (target: string) => string | undefined {
  // Built on FIRST USE, not up front. These two maps are consulted only to turn
  // a note's first embedded image into a vault path, and a vault whose notes
  // embed no images never asks even once — yet filling them walks all 4,165
  // files doing three `toLowerCase()` calls and a template concat each, which
  // measured 32 ms of a ~215 ms synchronous vault open on the measured vault
  // (where `resolveFile` was then called 0 times). Deferring costs one null
  // check per embedded image and is never slower than building them eagerly.
  let byName: Map<string, VaultFile> | null = null;
  let byRel: Map<string, VaultFile> | null = null;
  const buildIndexes = (): void => {
    byName = new Map<string, VaultFile>();
    byRel = new Map<string, VaultFile>();
    for (const f of files) {
      byRel.set(f.relPath.toLowerCase(), f);
      const nameKey = f.name.toLowerCase();
      if (!byName.has(nameKey)) byName.set(nameKey, f);
      byName.set(`${f.name}.${f.ext}`.toLowerCase(), f);
    }
  };

  return target => {
    if (!byName) buildIndexes();
    return resolveFile(target, byName!, byRel!)?.path;
  };
}

/**
 * Turn raw vault files + their text into note metadata: the [[links]] each note
 * makes and the first image it embeds (used for the graph thumbnail).
 */
export function buildNotes(
  files: VaultFile[],
  contents: Map<string, string>,
  only?: ReadonlySet<string>
): Record<string, NoteMeta> {
  const resolveImage = createImageResolver(files);

  const notes: Record<string, NoteMeta> = {};
  for (const f of files) {
    if (!isTextualVaultFile(f) || (only && !only.has(f.relPath))) continue;
    const src = contents.get(f.relPath) ?? "";
    // One wiki scan feeds both the links and the thumbnail image.
    const { links: rawLinks, firstImage } = extractLinksAndFirstImage(src);
    const firstImagePath = firstImage ? resolveImage(firstImage) : undefined;
    notes[f.relPath] = {
      relPath: f.relPath,
      title: f.name,
      rawLinks,
      tags: extractTags(src),
      aliases: extractAliases(src),
      firstImagePath,
    };
  }
  return notes;
}

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Re-extract link/tag/alias metadata from `src` against an existing meta.
 * Returns the refreshed meta, or `null` when nothing changed so callers can
 * keep the current `notes` object — its identity churn is what triggers the
 * graph rebuild, the backlink re-index, and every notes subscriber, and typing
 * prose leaves all three arrays untouched on most saves. Deliberately does NOT
 * refresh `firstImagePath` (the debounced save path never did; thumbnails
 * update on rescan). (Measured during the graph optimization campaign.)
 */
export function refreshedNoteMeta(cur: NoteMeta, src: string): NoteMeta | null {
  const rawLinks = extractLinks(src);
  const tags = extractTags(src);
  const aliases = extractAliases(src);
  if (
    sameStrings(cur.rawLinks, rawLinks) &&
    sameStrings(cur.tags, tags) &&
    sameStrings(cur.aliases, aliases)
  )
    return null;
  return { ...cur, rawLinks, tags, aliases };
}

function resolveFile(
  target: string,
  byName: Map<string, VaultFile>,
  byRel: Map<string, VaultFile>
): VaultFile | undefined {
  const t = target.trim().replace(/\\/g, "/").toLowerCase();
  const base = t.split("/").pop() ?? t;
  return (
    byRel.get(t) ||
    byRel.get(`${t}.md`) ||
    byName.get(t) ||
    byName.get(base) ||
    byName.get(`${base}.md`) ||
    undefined
  );
}

/**
 * Build a resolver from a [[target]] string to a note id (relPath).
 *
 * Building the index walks every note and lowercases its id, title, and each
 * alias, so it is O(notes) — call it ONCE and reuse the returned function for
 * every target. Resolving more than one link through `resolveTarget` rebuilds
 * the index per call, which is why the loops in `deepResearch` hoist this.
 */
export function makeResolver(
  notes: Record<string, NoteMeta>
): (t: string) => string | null {
  const byTitle = new Map<string, string>();
  const byRel = new Map<string, string>();
  for (const id of Object.keys(notes)) {
    byRel.set(id.toLowerCase(), id);
    if (/\.md$/i.test(id)) byRel.set(id.toLowerCase().replace(/\.md$/i, ""), id);
    const tl = notes[id].title.toLowerCase();
    if (!byTitle.has(tl)) byTitle.set(tl, id);
    for (const alias of notes[id].aliases) {
      const al = alias.toLowerCase();
      if (!byTitle.has(al)) byTitle.set(al, id);
    }
  }
  return (target: string): string | null => {
    const t = target.trim().replace(/\\/g, "/").toLowerCase().replace(/\.md$/, "");
    const base = t.split("/").pop() ?? t;
    return byTitle.get(t) ?? byRel.get(t) ?? byTitle.get(base) ?? byRel.get(base) ?? null;
  };
}

/**
 * Resolve a SINGLE [[target]] to a note id, or null. Builds a throwaway index,
 * so use `makeResolver` directly when resolving more than one target.
 */
export function resolveTarget(
  notes: Record<string, NoteMeta>,
  target: string
): string | null {
  return makeResolver(notes)(target);
}

/** Which node categories the graph shows. Mirrors Obsidian's graph Filters:
 *  each flag toggles a class of node (and its edges) in/out of the graph. */
export interface GraphFilterOptions {
  /** Show #tag nodes and the note→tag edges. */
  showTags: boolean;
  /** Only graph files that exist — hide placeholder nodes for unresolved [[links]]. */
  existingOnly: boolean;
  /** Show orphan text documents with no links. */
  showOrphans: boolean;
  /** Show attachment nodes — every non-text vault file. All attachments
   *  join the same force layout as notes, exactly like Obsidian: linked ones
   *  sit in the cluster, unlinked ones halo around it via shared repulsion. */
  showAttachments: boolean;
}

/** Default filters: text documents + orphans, no tag/phantom/attachment nodes. */
export const DEFAULT_GRAPH_FILTERS: GraphFilterOptions = {
  showTags: false,
  existingOnly: true,
  showOrphans: true,
  showAttachments: false,
};

/** Stable, collision-proof ids for the synthetic (non-file) node kinds. Real
 *  nodes are keyed by relPath; tag/phantom ids carry a NUL-delimited prefix that
 *  can never appear in a filesystem path. */
function tagNodeId(tag: string): string {
  return `\0tag\0${tag.toLowerCase()}`;
}
function phantomNodeId(name: string): string {
  return `\0phantom\0${name.toLowerCase()}`;
}
/** The display name for an unresolved [[link]] target (drop any #heading). */
function phantomName(rawLink: string): string {
  return (rawLink.split("#")[0] || rawLink).trim();
}

/** Image extensions that get a thumbnail when the attachment is linked. */
const ATTACHMENT_IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** Build the force-graph node/link sets from the vault.
 *
 * The graph includes every supported text document: each carries
 * its resolved [[wiki-link]] edges (and thus a link degree); unlinked notes are
 * isolated force nodes (degree 0) that halo around the connected cluster.
 *
 * Optional synthetic node classes are governed by `opts` (see
 * GraphFilterOptions), matching Obsidian-style graph filters:
 *   • tags     — each #tag becomes a node with an edge from every note using it.
 *   • phantoms — unresolved [[links]] become placeholder nodes (shown only when
 *                `existingOnly` is false).
 *   • orphans  — text documents with no links; dropped when `showOrphans` is
 *                false.
 * A note keeps its first embedded image as a thumbnail. */
export function buildGraph(
  notes: Record<string, NoteMeta>,
  files: VaultFile[],
  opts: GraphFilterOptions = DEFAULT_GRAPH_FILTERS
): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const ids = Object.keys(notes);
  const resolve = makeResolver(notes);
  // Both link passes below resolve every rawLink (pass 1 builds note→note
  // edges; pass 2 re-resolves the SAME raw to decide attachment/phantom
  // fallback), and hub targets repeat across many notes. Resolution is a pure
  // function of the raw string for fixed notes, so memoize per buildGraph
  // call: each unique raw is normalized once, every other lookup is a Map hit.
  // (Measured during the graph optimization campaign.)
  const resolveMemo = new Map<string, string | null>();
  const resolveCached = (raw: string): string | null => {
    let v = resolveMemo.get(raw);
    if (v === undefined) {
      v = resolve(raw);
      resolveMemo.set(raw, v);
    }
    return v;
  };
  const degree: Record<string, number> = {};
  const links: GraphLink[] = [];
  const seen = new Set<string>();

  // Titles for any synthetic nodes we create along the way.
  const tagTitle = new Map<string, string>();     // tagNodeId → "#tag"
  const phantomTitle = new Map<string, string>(); // phantomNodeId → "Name"

  // Attachment resolver: [[report.pdf]] → the non-text
  // vault file's relPath. Attachment nodes are keyed by relPath, same as notes.
  const attachmentByKey = new Map<string, string>();
  const attachmentFiles: VaultFile[] = [];
  for (const f of files) {
    if (notes[f.relPath]) continue;
    attachmentFiles.push(f);
    const rel = f.relPath.toLowerCase();
    if (!attachmentByKey.has(rel)) attachmentByKey.set(rel, f.relPath);
    const full = `${f.name}.${f.ext}`.toLowerCase();
    if (!attachmentByKey.has(full)) attachmentByKey.set(full, f.relPath);
  }
  const resolveAttachment = (target: string): string | null => {
    const t = target.trim().replace(/\\/g, "/").toLowerCase();
    const base = t.split("/").pop() ?? t;
    return attachmentByKey.get(t) ?? attachmentByKey.get(base) ?? null;
  };
  // Attachments that actually got an edge — used to decide which image
  // attachments earn a thumbnail (unlinked ones don't; see below).
  const linkedAttachments = new Set<string>();

  const addLink = (source: string, target: string): void => {
    const key = `${source}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target });
    degree[source] = (degree[source] ?? 0) + 1;
    degree[target] = (degree[target] ?? 0) + 1;
  };

  for (const id of ids) {
    for (const raw of notes[id].rawLinks) {
      const tgt = resolveCached(raw);
      if (!tgt || tgt === id) continue;
      const key = `${id}\u0000${tgt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: id, target: tgt });
      degree[id] = (degree[id] ?? 0) + 1;
      degree[tgt] = (degree[tgt] ?? 0) + 1;
    }
  }

  // Phantom, tag, and attachment edges, governed by the filter options.
  // Resolved note→note edges were added above.
  for (const id of ids) {
    for (const raw of notes[id].rawLinks) {
      if (resolveCached(raw)) continue; // resolved — already a note→note edge
      const att = resolveAttachment(raw);
      if (att) {
        // The target is a real non-text file: link it when attachments
        // are shown, and never phantom it (the file exists either way).
        if (opts.showAttachments) {
          linkedAttachments.add(att);
          addLink(id, att);
        }
        continue;
      }
      if (!opts.existingOnly) {
        const name = phantomName(raw);
        if (!name) continue;
        const pid = phantomNodeId(name);
        if (!phantomTitle.has(pid)) phantomTitle.set(pid, name);
        addLink(id, pid);
      }
    }
    if (opts.showTags) {
      for (const tag of notes[id].tags) {
        const tid = tagNodeId(tag);
        if (!tagTitle.has(tid)) tagTitle.set(tid, `#${tag}`);
        addLink(id, tid);
      }
    }
  }

  // Build a lookup from relPath → VaultFile so note nodes keep their extension.
  const fileByRel = new Map<string, VaultFile>();
  for (const f of files) fileByRel.set(f.relPath, f);

  const nodes: GraphNode[] = [];

  // Text-document nodes. `notes` contains every supported text file.
  for (const id of ids) {
    const f = fileByRel.get(id);
    const degreeCount = degree[id] ?? 0;
    // Orphan note (no links of any kind): drop when the orphan filter is off.
    if (!opts.showOrphans && degreeCount === 0) continue;
    nodes.push({
      id,
      title: notes[id].title,
      degree: degreeCount,
      thumbPath: notes[id].firstImagePath,
      kind: "note",
      ext: f?.ext ?? "md",
      ...(Number.isFinite(f?.createdAt ?? f?.mtime)
        ? { timelineTime: f!.createdAt ?? f!.mtime }
        : {}),
    });
  }

  // Attachment nodes: every non-text file in the vault. All of them are
  // ordinary force nodes — same simulation, same drag behavior, same halo
  // physics as notes — exactly like Obsidian. Unlinked attachments are simply
  // degree-0 nodes, so shared repulsion + gentle centering rings them loosely
  // around the connected core, the way Obsidian's yellow dot field forms.
  // Orphan filter applies to unlinked attachments exactly as it does to
  // unlinked notes.
  if (opts.showAttachments) {
    for (const f of attachmentFiles) {
      const degreeCount = degree[f.relPath] ?? 0;
      const linked = linkedAttachments.has(f.relPath);
      if (!linked && !opts.showOrphans) continue;
      nodes.push({
        id: f.relPath,
        title: `${f.name}.${f.ext}`,
        degree: degreeCount,
        // Only linked image attachments get a thumbnail: a vault can hold
        // thousands of unlinked assets, and decoding images for all of them
        // is exactly the kind of hidden cost that made past attempts laggy.
        thumbPath:
          linked && ATTACHMENT_IMAGE_EXT.test(f.ext) ? f.path : undefined,
        kind: "attachment",
        ext: f.ext,
        ...(Number.isFinite(f.createdAt ?? f.mtime)
          ? { timelineTime: f.createdAt ?? f.mtime }
          : {}),
      });
    }
  }

  // Tag nodes (only created when showTags is on).
  for (const [tid, title] of tagTitle) {
    const degreeCount = degree[tid] ?? 0;
    nodes.push({
      id: tid,
      title,
      degree: degreeCount,
      kind: "tag",
      ext: "",
    });
  }

  // Phantom nodes for unresolved links (only created when existingOnly is off).
  for (const [pid, title] of phantomTitle) {
    const degreeCount = degree[pid] ?? 0;
    nodes.push({
      id: pid,
      title,
      degree: degreeCount,
      kind: "phantom",
      ext: "",
    });
  }

  return { nodes, links };
}

/** Undirected neighbor map: node id → the set of ids it shares a link with.
 *  Powers the Obsidian-style hover focus (highlight a node's neighborhood,
 *  dim everything else). */
export function buildNeighbors(links: GraphLink[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    let s = out.get(a);
    if (!s) {
      s = new Set();
      out.set(a, s);
    }
    s.add(b);
  };
  for (const l of links) {
    const s = typeof l.source === "string" ? l.source : l.source.id;
    const t = typeof l.target === "string" ? l.target : l.target.id;
    add(s, t);
    add(t, s);
  }
  return out;
}

const assetIndexCache = new WeakMap<
  VaultFile[],
  { byRel: Map<string, string>; byBase: Map<string, string> }
>();
function assetIndex(files: VaultFile[]) {
  let idx = assetIndexCache.get(files);
  if (idx) return idx;
  const byRel = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const f of files) {
    const rel = f.relPath.toLowerCase();
    byRel.set(rel, f.path);
    const full = `${f.name}.${f.ext}`.toLowerCase();
    if (!byBase.has(full)) byBase.set(full, f.path);
    const name = f.name.toLowerCase();
    if (!byBase.has(name)) byBase.set(name, f.path);
  }
  idx = { byRel, byBase };
  assetIndexCache.set(files, idx);
  return idx;
}

/** Resolve an embedded asset name (e.g. `spark.svg`) to an absolute path. */
export function resolveAssetPath(files: VaultFile[], target: string): string | null {
  const t = target.trim().replace(/\\/g, "/").toLowerCase();
  const idx = assetIndex(files);
  const hit = idx.byRel.get(t);
  if (hit) return hit;
  const base = t.split("/").pop() ?? t;
  return idx.byBase.get(base) ?? null;
}

/** target id → sorted source ids, cached per notes-object identity. The store
 * replaces `notes` immutably on every mutation (spread copies in store.ts), so
 * an unchanged object identity means unchanged link topology and the index can
 * never go stale; the WeakMap frees it when the notes object is replaced. One
 * pass builds the whole index at the cost of a single uncached backlinksFor
 * call (with the same per-unique-raw resolve memo as buildGraph), so the
 * status bar count, the Backlinks panel, and repeated file switches all share
 * one compute per notes change instead of one full vault scan each.
 * (Measured during the graph optimization campaign.) */
const backlinkIndexCache = new WeakMap<
  Record<string, NoteMeta>,
  Map<string, string[]>
>();

function backlinkIndex(notes: Record<string, NoteMeta>): Map<string, string[]> {
  const hit = backlinkIndexCache.get(notes);
  if (hit) return hit;
  const idx = new Map<string, string[]>();
  const resolve = makeResolver(notes);
  const resolveMemo = new Map<string, string | null>();
  for (const id of Object.keys(notes)) {
    let seen: Set<string> | null = null; // most notes link to few targets
    for (const raw of notes[id].rawLinks) {
      let tgt = resolveMemo.get(raw);
      if (tgt === undefined) {
        tgt = resolve(raw);
        resolveMemo.set(raw, tgt);
      }
      // A note linking to itself is not a backlink (matches the pre-index
      // behavior of skipping id === targetId).
      if (!tgt || tgt === id || seen?.has(tgt)) continue;
      (seen ??= new Set()).add(tgt);
      const list = idx.get(tgt);
      if (list) list.push(id);
      else idx.set(tgt, [id]);
    }
  }
  for (const list of idx.values()) list.sort();
  backlinkIndexCache.set(notes, idx);
  return idx;
}

/** Notes that link *to* the given note. Treat the result as read-only — for a
 * cached notes object the same array is returned to every caller. */
export function backlinksFor(
  notes: Record<string, NoteMeta>,
  targetId: string
): string[] {
  return backlinkIndex(notes).get(targetId) ?? [];
}
