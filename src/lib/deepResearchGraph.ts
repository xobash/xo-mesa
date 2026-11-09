import type { ResearchActivity, ResearchActivityKind } from "./deepResearch";
import { canonicalizeSourceUrl } from "./deepResearchUrls";

/** Truthful live research graph: nodes come only from the query and real progress/navigation events. */

export type ResearchGraphNodeKind =
  | "query"
  | "plan"
  | "round"
  | "subquestion"
  | "search"
  | "source"
  | "note"
  | "synthesize";

export interface ResearchGraphNode {
  id: string;
  kind: ResearchGraphNodeKind;
  /** One-based position in the visible chronological research path. */
  step: number;
  label: string;
  /** Pre-wrapped preview lines for the node label. */
  lines: string[];
  truncated: boolean;
  height: number;
  /** Radius used by the responsive circular graph layout. */
  radius: number;
  /** Largest interactive radius; the layout reserves this space too. */
  hoverRadius: number;
  /** Baseline for the first pre-wrapped label line. */
  labelY: number;
  /** Width reserved for this label inside its non-overlapping grid cell. */
  labelMaxWidth: number;
  observed: boolean;
  latest: boolean;
  x: number;
  y: number;
  /** Canonical source URL when this node represents a source. */
  sourceUrl?: string;
  sourceStatus?: "reading" | "done";
  sourceObserved?: boolean;
}

export interface ResearchGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface ResearchGraphModel {
  width: number;
  height: number;
  nodeWidth: number;
  nodes: ResearchGraphNode[];
  edges: ResearchGraphEdge[];
  omitted: number;
}

export interface ResearchGraphLayout {
  width: number;
  height: number;
}

export interface ResearchGraphSource {
  url: string;
  title?: string;
  status?: "reading" | "done";
  observed?: boolean;
}

const GRAPH_ACTIVITY_KINDS = new Set<ResearchActivityKind>([
  "plan",
  "round",
  "subquestion",
  "search",
  "source",
  "note",
  "synthesize",
]);

function graphLabel(activity: ResearchActivity): string {
  if (activity.kind === "source") return activity.sourceTitle || activity.sourceUrl || activity.message;
  if (activity.kind === "subquestion") return activity.subQuestion || activity.message;
  return activity.message;
}

function graphColumn(kind: ResearchGraphNodeKind): number {
  switch (kind) {
    case "query": return 0;
    case "plan":
    case "round": return 1;
    case "subquestion": return 2;
    case "search":
    case "source":
    case "note": return 3;
    case "synthesize": return 4;
  }
}

const GRAPH_KIND_LABEL: Record<ResearchGraphNodeKind, string> = {
  query: "question",
  plan: "plan",
  round: "round",
  subquestion: "question",
  search: "search",
  source: "source",
  note: "note",
  synthesize: "write",
};

function previewGraphLabel(
  label: string,
  maxChars = 23,
  maxLines = 4
): { lines: string[]; truncated: boolean } {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let truncated = false;
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const original of words) {
    let word = original;
    while (word.length > maxChars) {
      flush();
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
      if (word) truncated = true;
    }
    if (truncated) break;
    if (!word) continue;
    if (line && `${line} ${word}`.length > maxChars) {
      flush();
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
    line += `${line ? " " : ""}${word}`;
  }
  flush();
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }
  const out = lines.length ? lines : ["(empty)"];
  if (truncated) {
    const last = out.length - 1;
    out[last] = out[last].replace(/\.*$/, "").trimEnd() + "...";
  }
  return { lines: out, truncated };
}

function compactResearchGraph(
  entries: Array<{
    kind: ResearchGraphNodeKind;
    label: string;
    observed: boolean;
    sourceIndex: number;
    nodeId?: string;
    sourceUrl?: string;
    sourceStatus?: "reading" | "done";
    sourceObserved?: boolean;
  }>,
  nodes: ResearchGraphNode[],
  layout: ResearchGraphLayout
): number {
  const width = Math.max(280, Math.round(layout.width));
  const height = Math.max(240, Math.round(layout.height));
  const count = Math.max(1, entries.length);
  const outerPad = 16;
  const usableWidth = Math.max(1, width - outerPad * 2);
  const usableHeight = Math.max(1, height - outerPad * 2);
  const hoverScale = 1.25;
  const maxKindFactor = 1.18;
  let best = {
    columns: 1,
    rows: count,
    cellWidth: usableWidth,
    cellHeight: usableHeight / count,
    labelLines: 1,
    baseRadius: 4,
  };
  let bestScore = Number.NEGATIVE_INFINITY;

  // A chronological serpentine grid gives every step a private cell. It also
  // makes every connection horizontal or vertical, so the path never becomes
  // a knot as the run grows. Re-evaluate the grid for every measured resize.
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = usableWidth / columns;
    const cellHeight = usableHeight / rows;
    const labelLines = cellHeight >= 72 && cellWidth >= 88 ? 3 : cellHeight >= 40 ? 2 : 1;
    const labelHeight = labelLines * 11;
    const circleZoneHeight = Math.max(1, cellHeight - labelHeight - 5);
    const maxHoverRadius = Math.max(
      1,
      Math.min((cellWidth - 10) / 2, (circleZoneHeight - 4) / 2)
    );
    const baseRadius = Math.min(18, maxHoverRadius / (hoverScale * maxKindFactor));
    const aspectPenalty = Math.abs(Math.log(Math.max(0.1, cellWidth / cellHeight)));
    const score = baseRadius * 100 + labelLines * 5 - aspectPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = { columns, rows, cellWidth, cellHeight, labelLines, baseRadius };
    }
  }

  const baseRadius = Math.max(3, best.baseRadius);
  const radiusFor = (kind: ResearchGraphNodeKind) => {
    const factor = kind === "query" ? 1.18 : kind === "note" ? 1.08 : kind === "synthesize" ? 1.1 : kind === "source" ? 0.94 : 1;
    return Math.max(3, Math.min(22, baseRadius * factor));
  };
  const labelMaxWidth = Math.max(12, best.cellWidth - 8);
  const maxChars = Math.max(4, Math.floor(labelMaxWidth / 5.4));
  const labelHeight = best.labelLines * 11;
  const circleZoneHeight = Math.max(1, best.cellHeight - labelHeight - 5);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const radius = radiusFor(entry.kind);
    const hoverRadius = radius * hoverScale;
    const row = Math.floor(i / best.columns);
    const logicalColumn = i % best.columns;
    const column = row % 2 === 0 ? logicalColumn : best.columns - logicalColumn - 1;
    const cellLeft = outerPad + column * best.cellWidth;
    const cellTop = outerPad + row * best.cellHeight;
    const x = cellLeft + best.cellWidth / 2;
    const y = cellTop + circleZoneHeight / 2;
    const stepLine = `${i + 1} ${GRAPH_KIND_LABEL[entry.kind]}`;
    const preview = previewGraphLabel(
      entry.label,
      maxChars,
      Math.max(1, best.labelLines - 1)
    );
    const lines = best.labelLines === 1
      ? [stepLine]
      : [stepLine, ...preview.lines.slice(0, best.labelLines - 1)];
    const truncated = best.labelLines === 1 || preview.truncated;
    const nodeId = entry.nodeId ?? (i === 0 ? "query" : `activity-${entry.sourceIndex}`);
    nodes.push({
      id: nodeId,
      kind: entry.kind,
      step: i + 1,
      label: entry.label.trim() || entry.kind,
      lines,
      truncated,
      height: best.cellHeight,
      radius,
      hoverRadius,
      labelY: cellTop + circleZoneHeight + 9,
      labelMaxWidth,
      observed: entry.observed,
      latest: i === entries.length - 1 && i > 0,
      x,
      y,
      sourceUrl: entry.sourceUrl,
      sourceStatus: entry.sourceStatus,
      sourceObserved: entry.sourceObserved,
    });
  }
  return best.cellWidth;
}

/** Build graph nodes only from the query and reported progress/navigation, not unannounced plan slots. */
export function buildResearchGraph(
  query: string,
  activity: ResearchActivity[],
  maxActivityNodes = 48,
  layout?: ResearchGraphLayout,
  sources: ResearchGraphSource[] = []
): ResearchGraphModel {
  const actual = activity.filter((a) => GRAPH_ACTIVITY_KINDS.has(a.kind));
  const visible = actual.length <= maxActivityNodes
    ? actual
    : [...actual.slice(0, 4), ...actual.slice(-(maxActivityNodes - 4))];
  const omitted = actual.length - visible.length;
  const sourceByUrl = new Map<string, ResearchGraphSource>();
  for (const source of sources) {
    const url = canonicalizeSourceUrl(source.url) ?? source.url;
    if (url) sourceByUrl.set(url, source);
  }
  const sourceUrlForActivity = (rawUrl?: string): string | undefined => {
    if (!rawUrl) return undefined;
    return canonicalizeSourceUrl(rawUrl) ?? rawUrl;
  };
  const entries: Array<{
    kind: ResearchGraphNodeKind;
    label: string;
    observed: boolean;
    sourceIndex: number;
    nodeId?: string;
    sourceUrl?: string;
    sourceStatus?: "reading" | "done";
    sourceObserved?: boolean;
  }> = [
    { kind: "query", label: query.trim() || "(empty question)", observed: false, sourceIndex: -1 },
    ...visible.map((a, i) => {
      const sourceUrl = sourceUrlForActivity(a.sourceUrl);
      const source = sourceUrl ? sourceByUrl.get(sourceUrl) : undefined;
      return {
        kind: a.kind as ResearchGraphNodeKind,
        label: source?.title || graphLabel(a),
        observed: Boolean(a.observed),
        sourceIndex: i,
        sourceUrl,
        sourceStatus: source?.status,
        sourceObserved: source?.observed,
      };
    }),
  ];

  const representedSources = new Set<string>();
  for (const entry of entries) {
    if (entry.sourceUrl) representedSources.add(entry.sourceUrl);
  }
  const sourceSlots = Math.max(0, maxActivityNodes - (entries.length - 1));
  let addedSources = 0;
  for (const [url, source] of sourceByUrl) {
    if (addedSources >= sourceSlots || representedSources.has(url)) continue;
    entries.push({
      kind: "source",
      label: source.title || url,
      observed: Boolean(source.observed),
      sourceIndex: -1,
      nodeId: `source-${entries.length}`,
      sourceUrl: url,
      sourceStatus: source.status,
      sourceObserved: source.observed,
    });
    representedSources.add(url);
    addedSources += 1;
  }

  const nodes: ResearchGraphNode[] = [];
  const nodeWidth = layout ? compactResearchGraph(entries, nodes, layout) : 130;
  let height = 220;
  if (!layout) {
    const columnOffsets = [42, 42, 42, 42, 42];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const column = graphColumn(entry.kind);
      const { lines, truncated } = previewGraphLabel(entry.label);
      const nodeHeight = Math.max(52, 30 + lines.length * 11);
      const y = columnOffsets[column];
      columnOffsets[column] += nodeHeight + 16;
      nodes.push({
        id: entry.nodeId ?? (i === 0 ? "query" : `activity-${entry.sourceIndex}`),
        kind: entry.kind,
        step: i + 1,
        label: entry.label.trim() || entry.kind,
        lines,
        truncated,
        height: nodeHeight,
        observed: entry.observed,
        latest: i === entries.length - 1 && i > 0,
        radius: nodeHeight / 2,
        hoverRadius: nodeHeight / 2,
        labelY: y + nodeHeight / 2 + 14,
        labelMaxWidth: 130,
        x: 34 + column * 148,
        y,
        sourceUrl: entry.sourceUrl,
        sourceStatus: entry.sourceStatus,
        sourceObserved: entry.sourceObserved,
      });
    }
    height = Math.max(220, ...nodes.map((node) => node.y + node.height + 26));
  } else {
    height = Math.max(240, Math.round(layout.height));
  }

  const edges = nodes.slice(1).map((node, i) => ({
    id: `edge-${i}`,
    source: nodes[i].id,
    target: node.id,
  }));
  return {
    width: layout ? Math.max(280, Math.round(layout.width)) : 700,
    height,
    nodeWidth,
    nodes,
    edges,
    omitted,
  };
}
