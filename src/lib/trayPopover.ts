import { buildGraph } from "./graph";
import { fuzzy } from "./fuzzy";
import type { NoteMeta, VaultFile } from "../types";
import type { RecentVault } from "./persistedUi";

/** State the main window sends to the menu bar popover (`tray.html`). */
export interface TrayPopoverState {
  vault: string | null;
  save: string;
  research: string | null;
  tasksSummary: string;
  sync: { enabled: boolean; busy: boolean; label: string };
  recents: TrayPopoverFile[];
  vaults: { id: string; label: string; current: boolean }[];
  query: string;
  results: TrayPopoverFile[];
  graph: MiniGraph;
  /** The open Mesa theme's graph colors, so the mini graph matches the real one. */
  palette: MiniGraphPalette;
}

export interface MiniGraphPalette {
  node: string;
  nodeActive: string;
  nodeIsolated: string;
  link: string;
  /** "r,g,b" for the bloom, active halo and hover ring. */
  glowRgb: string;
  bloomAlpha: number;
}

export interface TrayPopoverFile { rel: string; title: string; folder: string }

/** Nodes are the best-connected files; links index into `nodes`. */
export interface MiniGraph {
  nodes: { id: string; title: string; degree: number }[];
  links: [number, number][];
  active: number;
  total: number;
  pending: boolean;
}

export const POPOVER_LIST_LIMIT = 6;
export const POPOVER_VAULT_LIMIT = 6;
/** Keeps the popover's synchronous layout and the event payload small. */
export const MINI_GRAPH_NODES = 300;
export const MINI_GRAPH_LINKS = 1200;

export function popoverFile(file: Pick<VaultFile, "relPath" | "name">): TrayPopoverFile {
  const slash = file.relPath.lastIndexOf("/");
  return { rel: file.relPath, title: file.name, folder: slash > 0 ? file.relPath.slice(0, slash) : "" };
}

/** Best file-name matches, ranked like the command palette. */
export function searchFiles(files: readonly VaultFile[], query: string, limit = POPOVER_LIST_LIMIT): TrayPopoverFile[] {
  const q = query.trim();
  if (!q) return [];
  return files
    .map((f) => ({ f, score: fuzzy(q, f.name) + 0.4 * fuzzy(q, f.relPath) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.f.relPath.localeCompare(b.f.relPath))
    .slice(0, limit)
    .map((r) => popoverFile(r.f));
}

/** The most-connected part of the vault graph, always including the open note. */
export function miniGraph(notes: Record<string, NoteMeta>, files: VaultFile[], active: string | null, pending: boolean): MiniGraph {
  const graph = buildGraph(notes, files);
  const ranked = [...graph.nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const kept = ranked.slice(0, MINI_GRAPH_NODES);
  const activeNode = active ? graph.nodes.find((n) => n.id === active) : undefined;
  if (activeNode && !kept.includes(activeNode)) kept[kept.length - 1] = activeNode;
  // Unlinked files would float far from the clusters and shrink the fit, so
  // only files linked inside the kept set are drawn (plus the open note).
  const keptIds = new Set(kept.map((n) => n.id));
  const pairs = graph.links
    .map((l) => [String(l.source), String(l.target)] as const)
    .filter(([s, t]) => s !== t && keptIds.has(s) && keptIds.has(t));
  const linked = new Set(pairs.flat());
  const shown = kept.filter((n) => linked.has(n.id) || n.id === active);
  const index = new Map(shown.map((n, i) => [n.id, i]));
  const links: [number, number][] = [];
  for (const [s, t] of pairs) {
    links.push([index.get(s)!, index.get(t)!]);
    if (links.length >= MINI_GRAPH_LINKS) break;
  }
  return {
    nodes: shown.map((n) => ({ id: n.id, title: n.title, degree: n.degree })),
    links,
    active: active ? index.get(active) ?? -1 : -1,
    total: graph.nodes.length,
    pending,
  };
}

/** Most recent first, without duplicates or files that no longer exist. */
export function rememberRecent(recents: readonly string[], rel: string | null, exists: (rel: string) => boolean, limit = POPOVER_LIST_LIMIT): string[] {
  const next = rel ? [rel, ...recents.filter((r) => r !== rel)] : [...recents];
  return next.filter(exists).slice(0, limit);
}

export function popoverVaults(recent: readonly RecentVault[], current: string | null): TrayPopoverState["vaults"] {
  return recent.slice(0, POPOVER_VAULT_LIMIT).map((v) => ({ id: v.id, label: v.label, current: v.id === current }));
}
