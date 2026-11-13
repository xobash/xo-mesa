import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRemoteImageRewrite } from "./useRemoteImageRewrite";
import type { DeepResearchRunState } from "../store";
import { canonicalizeSourceUrl, presentResearchSource, type ResearchSourcePresentation } from "../lib/deepResearch";
import { buildResearchGraph, type ResearchGraphLayout } from "../lib/deepResearchGraph";
import { copyText } from "./deepResearchPanelHelpers";

export const GRAPH_NODE_GLYPH: Record<string, string> = {
  query: "?",
  plan: "▤",
  round: "↻",
  subquestion: "→",
  search: "⌕",
  source: "▹",
  note: "✓",
  synthesize: "✎",
};

export function ResearchActivityGraph({
  run,
  openFile,
}: {
  run: DeepResearchRunState;
  openFile: (relPath: string) => Promise<void>;
}) {
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const [graphLayout, setGraphLayout] = useState<ResearchGraphLayout>({ width: 700, height: 360 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedNode, setCopiedNode] = useState<string | null>(null);
  const graphDefsId = useId().replace(/:/g, "");
  const hoverTimerRef = useRef<number | null>(null);
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = graphCanvasRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setGraphLayout((current) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return current.width === width && current.height === height ? current : { width, height };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const graph = useMemo(
    () => buildResearchGraph(run.query, run.activity, 48, graphLayout, run.sources),
    [graphLayout, run.activity, run.query, run.sources]
  );
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const sourcePresentations = useMemo(() => {
    const presentations = new Map<string, ResearchSourcePresentation>();
    const byUrl = new Map<string, DeepResearchRunState["sources"][number]>();
    for (const source of run.sources) {
      const url = canonicalizeSourceUrl(source.url) ?? source.url;
      byUrl.set(url, source);
      const presentation = presentResearchSource(source.url, source.title);
      if (presentation) presentations.set(url, presentation);
    }
    return { byUrl, presentations };
  }, [run.sources]);
  const activeNodeId = hoveredId ?? selectedId;
  const hovered = activeNodeId ? byId.get(activeNodeId) ?? null : null;
  const hoveredSource = hovered?.sourceUrl
    ? sourcePresentations.byUrl.get(hovered.sourceUrl) ?? null
    : null;
  const hoveredPresentation = hovered?.sourceUrl
    ? sourcePresentations.presentations.get(hovered.sourceUrl) ?? null
    : null;
  // SVG paints siblings in DOM order. Keep the hovered node last so its
  // circle, glyph, and label stay readable above nearby graph content without
  // changing the settled layout or the hit-test geometry.
  const orderedNodes = hovered
    ? [...graph.nodes.filter((node) => node.id !== hovered.id), hovered]
    : graph.nodes;
  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  const showHover = (id: string) => {
    clearHoverTimer();
    setHoveredId(id);
  };
  const hideHover = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => setHoveredId(null), 140);
  };
  const activateNode = (id: string, focusActions = false) => {
    clearHoverTimer();
    setSelectedId((current) => (current === id ? null : id));
    setHoveredId(id);
    if (focusActions) {
      window.requestAnimationFrame(() => {
        hoverCardRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      });
    }
  };
  const copyNodeText = async (node: { id: string; label: string }) => {
    if (!(await copyText(node.label))) return;
    setCopiedNode(node.id);
    window.setTimeout(
      () => setCopiedNode((current) => (current === node.id ? null : current)),
      1800
    );
  };
  const copySourceLinkFromGraph = async (url: string) => {
    await copyText(url);
  };
  const actionCount = run.activity.filter((activity) => activity.kind !== "status").length;
  const cardWidth = Math.min(300, Math.max(220, graph.width - 24));
  const cardHeight = hoveredSource ? 158 : 118;
  const cardLeft = hovered
    ? hovered.x + hovered.radius * 1.55 + 14 + cardWidth <= graph.width - 8
      ? hovered.x + hovered.radius * 1.55 + 14
      : Math.max(8, hovered.x - hovered.radius * 1.55 - cardWidth - 14)
    : 8;
  const cardTop = hovered
    ? Math.max(8, Math.min(graph.height - cardHeight - 8, hovered.y - cardHeight / 2))
    : 8;
  return (
    <div className="dr-research-graph">
      <div className="dr-map-head">
        <div className="dr-map-title">Research path · {graph.nodes.length} steps</div>
        <div className="dr-map-hint">
          Start at 1 · follow the arrows · {actionCount} actions · {run.sources.length} sources
          {graph.omitted ? ` · ${graph.omitted} older actions omitted` : ""}
        </div>
      </div>
      <div
        ref={graphCanvasRef}
        className="dr-research-graph-canvas"
      >
        <svg
          className="dr-research-graph-svg"
          width={graph.width}
          height={graph.height}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          preserveAspectRatio="none"
          role="group"
          aria-label="Live Deep Research evidence graph"
        >
          <defs>
            <marker
              id={`${graphDefsId}-arrow`}
              className="dr-graph-arrow"
              viewBox="0 0 6 6"
              refX="5"
              refY="3"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 6 3 L 0 6 z" />
            </marker>
            {graph.nodes.map((node) => (
              <clipPath key={`${node.id}-clip`} id={`${graphDefsId}-clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`}>
                <rect
                  x={node.x - node.labelMaxWidth / 2}
                  y={node.labelY - 10}
                  width={node.labelMaxWidth}
                  height={node.lines.length * 11 + 3}
                />
              </clipPath>
            ))}
          </defs>
          <g className="dr-research-graph-edges">
            {graph.edges.map((edge) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;
              const sameRow = Math.abs(target.y - source.y) < 0.5;
              const direction = sameRow
                ? Math.sign(target.x - source.x) || 1
                : source.x >= graph.width / 2 ? 1 : -1;
              const startX = source.x + direction * (source.radius + 3);
              const targetX = target.x + (sameRow ? -direction : direction) * (target.radius + 7);
              const turnX = Math.max(
                4,
                Math.min(graph.width - 4, source.x + direction * (graph.nodeWidth / 2 - 3))
              );
              const path = sameRow
                ? `M ${startX} ${source.y} H ${targetX}`
                : `M ${startX} ${source.y} H ${turnX} V ${target.y} H ${targetX}`;
              return (
                <path
                  key={edge.id}
                  d={path}
                  markerEnd={`url(#${graphDefsId}-arrow)`}
                />
              );
            })}
          </g>
          <g className="dr-research-graph-nodes">
            {orderedNodes.map((node) => (
              <g
                key={node.id}
                className={
                  `dr-graph-node dr-graph-node-${node.kind}` +
                  (node.observed ? " observed" : " reported") +
                  (node.latest ? " latest" : "") +
                  (activeNodeId === node.id ? " hovered" : "")
                }
                tabIndex={0}
                role="button"
                data-escape-layer=""
                aria-label={`Step ${node.step} of ${graph.nodes.length}, ${node.kind}: ${node.label}. Open evidence actions.`}
                aria-pressed={selectedId === node.id}
                onFocus={() => showHover(node.id)}
                onBlur={hideHover}
                onClick={() => activateNode(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activateNode(node.id, true);
                  } else if (event.key === "Escape" && selectedId === node.id) {
                    event.preventDefault();
                    setSelectedId(null);
                    setHoveredId(null);
                  }
                }}
              >
                <title>{node.label}</title>
                <circle
                  className="dr-graph-node-circle"
                  cx={node.x}
                  cy={node.y}
                  r={activeNodeId === node.id ? node.hoverRadius : node.radius}
                  onMouseEnter={() => showHover(node.id)}
                  onMouseLeave={hideHover}
                />
                <circle
                  className="dr-graph-hitbox"
                  cx={node.x}
                  cy={node.y}
                  r={node.hoverRadius}
                  onMouseEnter={() => showHover(node.id)}
                  onMouseLeave={hideHover}
                />
                <text className="dr-graph-node-glyph" x={node.x} y={node.y + 4} textAnchor="middle">
                  {GRAPH_NODE_GLYPH[node.kind] ?? "·"}
                </text>
                <text
                  className="dr-graph-node-label"
                  x={node.x}
                  y={node.labelY}
                  textAnchor="middle"
                  aria-hidden="true"
                  clipPath={`url(#${graphDefsId}-clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, "-")})`}
                >
                  {node.lines.map((line, index) => (
                    <tspan key={`${node.id}-label-${index}`} x={node.x} dy={index === 0 ? 0 : 11}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            ))}
          </g>
        </svg>
        {hovered && (
          <div
            ref={hoverCardRef}
            className="dr-graph-hover-card"
            data-native-webview-occluder=""
            data-escape-layer=""
            style={{ left: cardLeft, top: cardTop, width: cardWidth }}
            onMouseEnter={clearHoverTimer}
            onMouseLeave={hideHover}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setSelectedId(null);
              setHoveredId(null);
            }}
          >
            {hoveredPresentation ? (
              <>
                <div className="dr-graph-hover-source-head">
                  <ResearchSourceIcon source={hoveredPresentation} />
                  <div className="dr-graph-hover-source-title">
                    <strong>{hoveredPresentation.siteName}</strong>
                    <span>{hoveredPresentation.pageTitle}</span>
                  </div>
                </div>
                <div className="dr-graph-hover-meta">
                  {hoveredSource?.status === "done" ? "Read" : "Reading"} · {hoveredSource?.observed ? "Mesa observed" : "Pi reported"}
                </div>
                <div className="dr-graph-hover-actions">
                  <button type="button" className="dr-source-link" onClick={() => void copySourceLinkFromGraph(hoveredPresentation.url)}>
                    Copy link · {hoveredPresentation.host}
                  </button>
                  {hoveredSource?.archiveRelPath && (
                    <button type="button" className="dr-source-link dr-source-open" onClick={() => void openFile(hoveredSource.archiveRelPath!)}>
                      Open saved page
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="dr-graph-hover-kind">{hovered.kind}</div>
                <div className="dr-graph-hover-text">{hovered.label}</div>
                <div className="dr-graph-hover-meta">{hovered.observed ? "Mesa observed" : "Pi reported"}</div>
                <button
                  type="button"
                  className="dr-source-link"
                  onClick={() => void copyNodeText(hovered)}
                >
                  {copiedNode === hovered.id ? "Copied" : "Copy full text"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {graph.nodes.length === 1 && (
        <div className="dr-graph-empty">
          No research action has been observed yet. Mesa is waiting for Pi to submit a model or browser signal.
        </div>
      )}
      <div className="dr-graph-legend">
        <span><i className="dr-legend-dot reported" /> Pi reported</span>
        <span><i className="dr-legend-dot observed" /> Mesa observed</span>
      </div>
    </div>
  );
}

export function ResearchSourceIcon({ source }: { source: ResearchSourcePresentation }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source.faviconUrl]);
  // Favicons load through Mesa's image broker; the app CSP blocks direct remote images.
  const rewrite = useRemoteImageRewrite(true);
  const src = rewrite ? rewrite(source.faviconUrl) : "";
  return (
    <span className="dr-source-icon" title={source.siteName} aria-hidden="true">
      {failed || !src ? (
        <span className="dr-source-icon-fallback">{source.initial}</span>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
