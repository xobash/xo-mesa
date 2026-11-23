import type { GraphFileGroup, GraphNode } from "../types";

/** Tag and phantom nodes are synthetic — they have no backing file, so they
 *  can't be opened or previewed like a real note. */
export function isSyntheticNode(n: GraphNode): boolean {
  return n.kind === "tag" || n.kind === "phantom";
}

/** Pick the fill colour for a graph node. */
export function nodeFill(n: GraphNode, c: GraphColors): string {
  switch (n.kind) {
    case "note":
      return c.node;
    case "tag":
      return c.nodeTag;
    case "phantom":
      return c.nodePhantom;
    case "attachment":
      // Only the opt-in All files view sets a group; Obsidian's Attachments
      // filter draws every attachment in one colour.
      return n.fileGroup && n.fileGroup !== "other" ? c.fileGroups[n.fileGroup] : c.nodeAttachment;
  }
}

export interface GraphColors {
  node: string;
  nodeActive: string;
  /** Tray mini graph only; the main graph draws every note in `node`. */
  nodeIsolated: string;
  link: string;
  linkActive: string;
  flickerRgb: string; // "r,g,b" so we can vary alpha for the glow
  bloomAlpha: number;
  label: string;
  thumbBorder: string;
  nodeTag: string;
  nodePhantom: string;
  nodeAttachment: string;
  /** All files view colours; "other" files use `nodeAttachment`. */
  fileGroups: Record<Exclude<GraphFileGroup, "other">, string>;
}

export function readGraphColors(): GraphColors {
  const cs = getComputedStyle(document.documentElement);
  const g = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  const n = (name: string, fallback: number) => {
    const value = Number.parseFloat(cs.getPropertyValue(name).trim());
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    node: g("--graph-node", "#7d8bb0"),
    nodeActive: g("--graph-node-active", "#58a6ff"),
    nodeIsolated: g("--graph-node-isolated", "#55607d"),
    link: g("--graph-link", "rgba(120,134,170,0.18)"),
    linkActive: g("--graph-link-active", "rgba(88,166,255,0.55)"),
    flickerRgb: g("--graph-flicker-rgb", "122,230,168"),
    bloomAlpha: n("--graph-bloom-alpha", 1),
    label: g("--graph-label", "rgba(220,228,245,0.92)"),
    thumbBorder: g("--graph-thumb-border", "rgba(203,230,255,0.5)"),
    nodeTag: g("--graph-node-tag", "#3fb6c9"),
    nodePhantom: g("--graph-node-phantom", "#4a4a55"),
    nodeAttachment: g("--graph-node-attachment", "#c9c96a"),
    fileGroups: {
      image: g("--graph-node-image", "#e489a8"),
      pdf: g("--graph-node-pdf", "#e36d5d"),
      media: g("--graph-node-media", "#b48be6"),
      office: g("--graph-node-office", "#6ea2ea"),
      archive: g("--graph-node-archive", "#a39484"),
    },
  };
}
