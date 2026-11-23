import type { VaultFile, NoteMeta, GraphNode, GraphLink } from "../types";
import { extractLinksAndFirstImage, extractTags, extractAliases } from "./markdownExtract";
import { isMarkdownPath } from "./markdownCode";
import { isTextualVaultFile } from "./vault";
import { linkKey } from "./fsnames";
import { createFileLinkResolver, graphFileGroup, graphFileTitle } from "./graphFiles";

/** Shared lazy image lookup for parsed and persisted note metadata. */
export function createImageResolver(files: readonly VaultFile[]): (target: string) => string | undefined {
  // Build image lookup indexes on first use; notes without images need none.
  let byName: Map<string, VaultFile> | null = null;
  let byRel: Map<string, VaultFile> | null = null;
  const buildIndexes = (): void => {
    byName = new Map<string, VaultFile>();
    byRel = new Map<string, VaultFile>();
    for (const f of files) {
      byRel.set(linkKey(f.relPath), f);
      const nameKey = linkKey(f.name);
      if (!byName.has(nameKey)) byName.set(nameKey, f);
      byName.set(linkKey(`${f.name}.${f.ext}`), f);
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
    notes[f.relPath] = noteMetaFor(f, contents.get(f.relPath) ?? "", resolveImage).note;
  }
  return notes;
}

/** One document's `buildNotes` metadata plus its raw first-image target.
 *  Batch callers share one whole-vault `resolveImage` across batches. */
export function noteMetaFor(
  f: Pick<VaultFile, "relPath" | "name" | "isMarkdown">,
  src: string,
  resolveImage: (target: string) => string | undefined
): { note: NoteMeta; firstImage: string | null } {
  // One wiki scan feeds both the links and the thumbnail image.
  const { links: rawLinks, references: rawReferences, firstImage } = extractLinksAndFirstImage(src, !!f.isMarkdown);
  return {
    note: {
      relPath: f.relPath,
      title: f.name,
      rawLinks,
      rawReferences,
      tags: extractTags(src, !!f.isMarkdown),
      aliases: extractAliases(src),
      firstImagePath: firstImage ? resolveImage(firstImage) : undefined,
    },
    firstImage,
  };
}

/** Metadata for one note added outside a full rebuild. Every entry carries
 *  `rawReferences` so rename inspects only real link candidates; the graph
 *  thumbnail resolves on the next rebuild. */
export function singleNoteMeta(f: Pick<VaultFile, "relPath" | "name">, src: string): NoteMeta {
  return noteMetaFor({ ...f, isMarkdown: isMarkdownPath(f.relPath) }, src, () => undefined).note;
}

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Refresh link/tag/alias metadata, returning null when it is unchanged.
 * Preserves notes-object identity for topology caches. Thumbnails update on rescan.
 * An entry without `rawReferences` always refreshes so it gains the field. */
export function refreshedNoteMeta(cur: NoteMeta, src: string): NoteMeta | null {
  const markdown = isMarkdownPath(cur.relPath);
  const { links: rawLinks, references: rawReferences } = extractLinksAndFirstImage(src, markdown);
  const tags = extractTags(src, markdown);
  const aliases = extractAliases(src);
  if (
    sameStrings(cur.rawLinks, rawLinks) &&
    cur.rawReferences !== undefined &&
    sameStrings(cur.rawReferences, rawReferences) &&
    sameStrings(cur.tags, tags) &&
    sameStrings(cur.aliases, aliases)
  )
    return null;
  return { ...cur, rawLinks, rawReferences, tags, aliases };
}

function resolveFile(
  target: string,
  byName: Map<string, VaultFile>,
  byRel: Map<string, VaultFile>
): VaultFile | undefined {
  const t = linkKey(target.trim().replace(/\\/g, "/"));
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

/** Build one note-target index and reuse its resolver for multiple lookups. */
export function makeResolver(
  notes: Record<string, NoteMeta>
): (t: string) => string | null {
  const byTitle = new Map<string, string>();
  const byRel = new Map<string, string>();
  for (const id of Object.keys(notes)) {
    const idKey = linkKey(id);
    byRel.set(idKey, id);
    if (/\.md$/i.test(id)) byRel.set(idKey.replace(/\.md$/i, ""), id);
    const tl = linkKey(notes[id].title);
    if (!byTitle.has(tl)) byTitle.set(tl, id);
    for (const alias of notes[id].aliases) {
      const al = linkKey(alias);
      if (!byTitle.has(al)) byTitle.set(al, id);
    }
  }
  const lookup = (target: string): string | null => {
    // A leading "/" names a path from the vault root.
    const t = linkKey(target.trim().replace(/\\/g, "/").replace(/^\/+/, "")).replace(/\.md$/, "");
    const base = t.split("/").pop() ?? t;
    return byTitle.get(t) ?? byRel.get(t) ?? byTitle.get(base) ?? byRel.get(base) ?? null;
  };
  // `[[Note#Heading]]` and `[[Note#^block]]` name the note before the
  // fragment, as link navigation does; an exact name still wins first.
  return (target: string): string | null => {
    const hit = lookup(target);
    const hash = target.indexOf("#");
    if (hit || hash < 0) return hit;
    const note = target.slice(0, hash);
    return note.trim() ? lookup(note) : null;
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
  /** Show every file that is not a Markdown note, as Obsidian's Attachments
   *  filter does: other text documents (which keep their parsed links) and
   *  non-text files. All of them join the same force layout as notes. */
  showAttachments: boolean;
  /** Mesa's opt-in "All files" view: every cataloged file is a node, whatever
   *  `showAttachments` and `showOrphans` say, and non-note files carry a
   *  colour group. Tags and unresolved links keep their own filters. */
  showAllFiles?: boolean;
}

/** Obsidian's default filters: Markdown notes, unresolved links and orphans; no tags or attachments. */
const DEFAULT_GRAPH_FILTERS: GraphFilterOptions = {
  showTags: false,
  existingOnly: false,
  showOrphans: true,
  showAttachments: false,
};

/** Stable, collision-proof ids for the synthetic (non-file) node kinds. Real
 *  nodes are keyed by relPath; tag/phantom ids carry a NUL-delimited prefix that
 *  can never appear in a filesystem path. */
function tagNodeId(tag: string): string {
  return `\0tag\0${linkKey(tag)}`;
}
function phantomNodeId(name: string): string {
  return `\0phantom\0${linkKey(name)}`;
}
/** The display name for an unresolved [[link]] target, without any #heading.
 *  Empty for a same-note heading link (`[[#Heading]]`), which is no node. */
function phantomName(rawLink: string): string {
  return rawLink.split("#")[0].trim();
}

/** Image extensions that get a thumbnail when the attachment is linked. */
const ATTACHMENT_IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** Build the force-graph node/link sets from the vault.
 *
 * The graph includes every Markdown note: each carries its resolved
 * [[wiki-link]] edges (and thus a link degree); unlinked notes are isolated
 * force nodes (degree 0). Other text documents and non-text files join only
 * when `showAttachments` is on; a link to a hidden file is dropped.
 *
 * Optional synthetic node classes are governed by `opts` (see
 * GraphFilterOptions), matching Obsidian-style graph filters:
 *   • tags     — each #tag becomes a node with an edge from every note using it.
 *   • phantoms — unresolved [[links]] become placeholder nodes (shown only when
 *                `existingOnly` is false).
 *   • orphans  — text documents with no links; dropped when `showOrphans` is
 *                false.
 * A note keeps its first embedded image as a thumbnail. */
/** One note's resolved links, reusable while nothing that affects resolution changes. */
interface NoteLinks {
  meta: NoteMeta;
  /** Note targets from the first pass, deduplicated, in order. */
  notes: string[];
  /** Phantom, file and tag targets in order; `dup` repeats an earlier target of this note. */
  others: { target: string; kind: "phantom" | "file" | "tag"; title: string; attach: boolean; dup: boolean }[];
  /** Every distinct target, as `GraphTopology.targets` holds it. */
  targets: Set<string>;
}

interface GraphBuildContext {
  notes: Record<string, NoteMeta>;
  keys: string[];
  rels: string[];
  opts: string;
  resolve: (raw: string) => string | null;
  resolveFileLink: (raw: string, from: string) => string | null;
  links: Map<string, NoteLinks>;
}

/**
 * A graph builder that keeps each note's resolved links between builds. While
 * the note list (in order), every title and alias, the file list and the
 * filters stay the same, only notes whose record changed resolve again; the
 * output equals `buildGraph` exactly (`graph.test.ts` "builder").
 */
export interface GraphBuilder {
  (notes: Record<string, NoteMeta>, files: VaultFile[], opts?: GraphFilterOptions): ReturnType<typeof buildGraph>;
  /**
   * Resolve notes for these inputs until `deadline` (a `performance.now()`
   * time); true once every note is resolved, so the next build only
   * assembles. Lets a heavy first build run in short steps.
   */
  prepare(notes: Record<string, NoteMeta>, files: VaultFile[], opts: GraphFilterOptions, deadline: number): boolean;
}

export function createGraphBuilder(): GraphBuilder {
  let previous: GraphBuildContext | null = null;
  const build = ((notes, files, opts = DEFAULT_GRAPH_FILTERS) => {
    const built = buildGraphWith(notes, files, opts, previous);
    previous = built.context;
    return built.graph!;
  }) as GraphBuilder;
  build.prepare = (notes, files, opts, deadline) => {
    const built = buildGraphWith(notes, files, opts, previous, deadline);
    previous = built.context;
    return built.resolved;
  };
  return build;
}

function reusableContext(previous: GraphBuildContext | null, notes: Record<string, NoteMeta>, keys: string[], files: VaultFile[], opts: string): boolean {
  if (!previous || previous.opts !== opts || previous.keys.length !== keys.length || previous.rels.length !== files.length) return false;
  for (let i = 0; i < files.length; i++) if (previous.rels[i] !== files[i].relPath) return false;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    if (previous.keys[i] !== id) return false;
    const a = previous.notes[id], b = notes[id];
    if (a !== b && (a.title !== b.title || !sameList(a.aliases, b.aliases))) return false;
  }
  return true;
}

export function buildGraph(
  notes: Record<string, NoteMeta>,
  files: VaultFile[],
  opts: GraphFilterOptions = DEFAULT_GRAPH_FILTERS
): {
  nodes: GraphNode[];
  links: GraphLink[];
  topology: GraphTopology;
} {
  return buildGraphWith(notes, files, opts, null).graph!;
}

function buildGraphWith(
  notes: Record<string, NoteMeta>,
  files: VaultFile[],
  opts: GraphFilterOptions,
  previous: GraphBuildContext | null,
  deadline?: number
): { graph: ReturnType<typeof buildGraph> | null; context: GraphBuildContext; resolved: boolean } {
  const allFiles = opts.showAllFiles === true;
  const nonNotes = allFiles || opts.showAttachments;
  // Markdown notes always; other text documents only with attachments shown.
  const shown = (id: string): boolean => nonNotes || isMarkdownPath(id);
  const keys = Object.keys(notes);
  const ids = keys.filter(shown);
  const optsKey = [allFiles, nonNotes, !!opts.existingOnly, !!opts.showTags].join();
  const reuse = reusableContext(previous, notes, keys, files, optsKey);
  let resolve: (raw: string) => string | null;
  let resolveFileLink: (raw: string, from: string) => string | null;
  if (reuse) {
    ({ resolve, resolveFileLink } = previous!);
  } else {
    const resolveTarget = makeResolver(notes);
    // Cache resolution per context so repeated raw targets share one normalization.
    const resolveMemo = new Map<string, string | null>();
    resolve = (raw) => {
      let v = resolveMemo.get(raw);
      if (v === undefined) {
        v = resolveTarget(raw);
        resolveMemo.set(raw, v);
      }
      return v;
    };
    // Resolves [[report.pdf#page=2]], ![[photo.png]], [a](../b.pdf) and bare
    // extensionless names to any cataloged file. Markdown targets are left to
    // the note resolver, so note-to-note edges are unchanged.
    const resolveAnyFile = createFileLinkResolver(files);
    // `from` matters only for a path with "/" (also written "\\" or escaped
    // with "%"), so other targets resolve once per context.
    const fileMemo = new Map<string, string | null>();
    resolveFileLink = (raw, from) => {
      const memo = !raw.includes("/") && !raw.includes("\\") && !raw.includes("%");
      let hit = memo ? fileMemo.get(raw) : undefined;
      if (hit === undefined) {
        const found = resolveAnyFile(raw, from);
        hit = found && !isMarkdownPath(found) ? found : null;
        if (memo) fileMemo.set(raw, hit);
      }
      return hit;
    };
  }

  /** The first pass (note links), then phantom, file and tag links, deduplicated per source. */
  const resolveNote = (id: string): NoteLinks => {
    const meta = notes[id];
    const targets = new Set<string>();
    const noteTargets: string[] = [];
    for (const raw of meta.rawLinks) {
      const tgt = resolve(raw);
      if (!tgt || tgt === id || !shown(tgt) || targets.has(tgt)) continue;
      targets.add(tgt);
      noteTargets.push(tgt);
    }
    const others: NoteLinks["others"] = [];
    const add = (target: string, kind: "phantom" | "file" | "tag", title: string, attach: boolean) => {
      const dup = targets.has(target);
      targets.add(target);
      others.push({ target, kind, title, attach, dup });
    };
    for (const raw of meta.rawLinks) {
      if (resolve(raw)) continue; // resolved — already a note→note edge
      if (resolveFileLink(raw, id)) continue; // a real file: linked below, never a phantom
      if (!opts.existingOnly) {
        const name = phantomName(raw);
        if (name) add(phantomNodeId(name), "phantom", name, false);
      }
    }
    // Every local reference (wiki links, embeds, Markdown links and images,
    // reference definitions) that names a non-Markdown file becomes an edge
    // when those files are shown.
    if (nonNotes) {
      for (const raw of meta.rawReferences ?? meta.rawLinks) {
        const target = resolveFileLink(raw, id);
        if (target && target !== id) add(target, "file", "", !notes[target]);
      }
    }
    if (opts.showTags) for (const tag of meta.tags) add(tagNodeId(tag), "tag", `#${tag}`, false);
    return { meta, notes: noteTargets, others, targets };
  };

  const noteLinks = new Map<string, NoteLinks>();
  const context = (): GraphBuildContext => ({ notes, keys, rels: files.map((f) => f.relPath), opts: optsKey, resolve, resolveFileLink, links: noteLinks });
  let fresh = 0;
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    const cached = reuse ? previous!.links.get(id) : undefined;
    if (cached && cached.meta === notes[id]) {
      noteLinks.set(id, cached);
      continue;
    }
    noteLinks.set(id, resolveNote(id));
    // A stepped build checks its deadline every 64 newly resolved notes and
    // keeps what it resolved.
    if (deadline !== undefined && (++fresh & 63) === 0 && k + 1 < ids.length && performance.now() > deadline) {
      for (let rest = k + 1; rest < ids.length; rest++) {
        const kept = reuse ? previous!.links.get(ids[rest]) : undefined;
        if (kept) noteLinks.set(ids[rest], kept);
      }
      return { graph: null, context: context(), resolved: false };
    }
  }
  // Preparing stops here; the next build reuses every resolved note.
  if (deadline !== undefined) return { graph: null, context: context(), resolved: true };

  const degree = new Map<string, number>();
  const links: GraphLink[] = [];
  // Targets per source, for the topology check.
  const targetsOf = new Map<string, Set<string>>();
  // Titles for any synthetic nodes; the first note (in note order) to name one wins.
  const tagTitle = new Map<string, string>();     // tagNodeId → "#tag"
  const phantomTitle = new Map<string, string>(); // phantomNodeId → "Name"
  // Attachments that actually got an edge — used to decide which image
  // attachments earn a thumbnail (unlinked ones don't; see below).
  const linkedAttachments = new Set<string>();
  const count = (source: string, target: string) => {
    links.push({ source, target });
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  };
  for (const id of ids) {
    const record = noteLinks.get(id)!;
    for (const target of record.notes) count(id, target);
    if (record.targets.size) targetsOf.set(id, record.targets);
  }
  for (const id of ids) {
    for (const other of noteLinks.get(id)!.others) {
      if (other.kind === "phantom" && !phantomTitle.has(other.target)) phantomTitle.set(other.target, other.title);
      else if (other.kind === "tag" && !tagTitle.has(other.target)) tagTitle.set(other.target, other.title);
      else if (other.attach) linkedAttachments.add(other.target);
      if (!other.dup) count(id, other.target);
    }
  }

  // Files without note metadata (non-text files and unread text files) are
  // attachment nodes, keyed by relPath like notes.
  const attachmentFiles: VaultFile[] = [];
  for (const f of files) if (!notes[f.relPath]) attachmentFiles.push(f);

  // Build a lookup from relPath → VaultFile so note nodes keep their extension.
  const fileByRel = new Map<string, VaultFile>();
  for (const f of files) fileByRel.set(f.relPath, f);

  const nodes: GraphNode[] = [];

  // Text-document nodes. `notes` contains every supported text file.
  for (const id of ids) {
    const f = fileByRel.get(id);
    const degreeCount = degree.get(id) ?? 0;
    // Orphan note (no links of any kind): drop when the orphan filter is off.
    if (!opts.showOrphans && !allFiles && degreeCount === 0) continue;
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

  // Attachments share the note force layout; the orphan filter also applies to them.
  if (nonNotes) {
    for (const f of attachmentFiles) {
      const degreeCount = degree.get(f.relPath) ?? 0;
      const linked = linkedAttachments.has(f.relPath);
      if (!linked && !opts.showOrphans && !allFiles) continue;
      nodes.push({
        id: f.relPath,
        title: graphFileTitle(f),
        degree: degreeCount,
        // Only linked image attachments receive thumbnails.
        thumbPath:
          linked && ATTACHMENT_IMAGE_EXT.test(f.ext) ? f.path : undefined,
        kind: "attachment",
        ...(allFiles ? { fileGroup: graphFileGroup(f.ext) } : {}),
        ext: f.ext,
        ...(Number.isFinite(f.createdAt ?? f.mtime)
          ? { timelineTime: f.createdAt ?? f.mtime }
          : {}),
      });
    }
  }

  // Tag nodes (only created when showTags is on).
  for (const [tid, title] of tagTitle) {
    const degreeCount = degree.get(tid) ?? 0;
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
    const degreeCount = degree.get(pid) ?? 0;
    nodes.push({
      id: pid,
      title,
      degree: degreeCount,
      kind: "phantom",
      ext: "",
    });
  }

  return {
    graph: { nodes, links, topology: { ids: new Set(nodes.map((n) => n.id)), targets: targetsOf, links: links.length } },
    context: context(),
    resolved: true,
  };
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * True when `next` builds the same graph as `prev`: the same notes, in the
 * same order, with the same title, links, references, tags, aliases and
 * first image. Index patches and watcher refreshes replace note records that
 * keep all of these; the graph then skips a rebuild.
 */
export function sameGraphNotes(prev: Record<string, NoteMeta>, next: Record<string, NoteMeta>): boolean {
  if (prev === next) return true;
  // Note order decides which of two equal titles a link resolves to.
  const order = Object.keys(prev);
  let count = 0;
  for (const rel in next) {
    if (order[count++] !== rel) return false;
    const a = prev[rel], b = next[rel];
    if (a === b) continue;
    if (!a || a.title !== b.title || a.firstImagePath !== b.firstImagePath || !sameList(a.rawLinks, b.rawLinks) ||
      !sameList(a.rawReferences, b.rawReferences) || !sameList(a.tags, b.tags) || !sameList(a.aliases, b.aliases)) return false;
  }
  return count === order.length;
}

/** Node ids and link pairs of one build, for an O(nodes + links) topology check. */
export interface GraphTopology {
  ids: ReadonlySet<string>;
  /** Link targets per source; `buildGraph` adds every link through it. */
  targets: ReadonlyMap<string, ReadonlySet<string>>;
  links: number;
}

/**
 * True when two builds have the same node ids and the same links, in any
 * order, without building a sorted signature string.
 */
export function sameGraphTopology(a: GraphTopology | null, b: GraphTopology): boolean {
  if (!a || a.ids.size !== b.ids.size || a.links !== b.links || a.targets.size !== b.targets.size) return false;
  for (const id of b.ids) if (!a.ids.has(id)) return false;
  for (const [source, targets] of b.targets) {
    const before = a.targets.get(source);
    if (!before || before.size !== targets.size) return false;
    for (const target of targets) if (!before.has(target)) return false;
  }
  return true;
}

/** The catalog fields `buildGraph` reads, copied by value. The watcher updates
 *  size and mtime on the existing file objects, so an earlier `files` array
 *  cannot show what changed. */
export interface GraphFileSnapshot {
  rel: string[];
  path: string[];
  ext: string[];
  time: number[];
}

/** The time `buildGraph` gives a file node: creation, else modification. */
function graphFileTime(f: VaultFile): number {
  const time = f.createdAt ?? f.mtime;
  return Number.isFinite(time) ? time! : NaN;
}

export function graphFileSnapshot(files: readonly VaultFile[]): GraphFileSnapshot {
  return {
    rel: files.map((f) => f.relPath),
    path: files.map((f) => f.path),
    ext: files.map((f) => f.ext),
    time: files.map(graphFileTime),
  };
}

/** True when `files` would build the same graph as the snapshot, for the same notes. */
export function sameGraphFiles(snapshot: GraphFileSnapshot, files: readonly VaultFile[]): boolean {
  if (snapshot.rel.length !== files.length) return false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const time = graphFileTime(f);
    const before = snapshot.time[i];
    if (snapshot.rel[i] !== f.relPath || snapshot.path[i] !== f.path || snapshot.ext[i] !== f.ext) return false;
    if (time !== before && !(Number.isNaN(time) && Number.isNaN(before))) return false;
  }
  return true;
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
    const rel = linkKey(f.relPath);
    byRel.set(rel, f.path);
    const full = linkKey(`${f.name}.${f.ext}`);
    if (!byBase.has(full)) byBase.set(full, f.path);
    const name = linkKey(f.name);
    if (!byBase.has(name)) byBase.set(name, f.path);
  }
  idx = { byRel, byBase };
  assetIndexCache.set(files, idx);
  return idx;
}

/** Resolve an embedded asset name (e.g. `spark.svg`) to an absolute path. */
export function resolveAssetPath(files: VaultFile[], target: string): string | null {
  const t = linkKey(target.trim().replace(/\\/g, "/"));
  const idx = assetIndex(files);
  const hit = idx.byRel.get(t);
  if (hit) return hit;
  const base = t.split("/").pop() ?? t;
  return idx.byBase.get(base) ?? null;
}

/** Target id → sorted source ids, cached by immutable notes-object identity.
 * Callers must replace the notes object when link metadata changes. */
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
