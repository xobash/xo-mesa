import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAppStore, getStore } from "../store";
import type { DeepResearchRunState } from "../store";
import { IN_TAURI } from "../lib/vault";
import {
  RESEARCH_DEPTH_PRESETS,
  DEPTH_LIMITS,
  clampDepth,
  buildResearchGraph,
  canonicalizeSourceUrl,
  presentResearchSource,
  type ResearchContextScope,
  type ResearchDepth,
  type ResearchDepthPreset,
  type ResearchActivity,
  type ResearchGraphLayout,
  type ResearchSourcePresentation,
} from "../lib/deepResearch";
import {
  buildResearchCompletionExport,
  buildResearchTroubleshootingKit,
  RESEARCH_TROUBLESHOOTING_IDLE_MS,
  researchTroubleshootingTrigger,
} from "../lib/deepResearchDiagnostics";
import { currentPiSessionId } from "../lib/deepResearchRun";
import { saveTextFile } from "../lib/saveTextFile";
import { invoke } from "@tauri-apps/api/core";

/**
 * Deep Research surface — the single UI for a Deep Research run, mounted from
 * both launch points (the Steam-overlay dock window and the Pi agent panel).
 * It reads and drives the ONE shared `deepResearch` store run; there is no
 * per-surface state machine.
 *
 * The panel is built for VISIBILITY: the user watches the agent work, not a
 * single-word status. Its evidence graph combines the sub-question plan,
 * activity, and source nodes in one bounded surface with Obsidian-style hover
 * previews. The panel also keeps a scrolling activity feed, the confidence
 * breakdown of gathered claims, and the full proposed change set with a
 * preview before anything touches the vault.
 *
 * Thoroughness is customizable: a depth preset (quick / standard / deep) plus
 * per-run controls for sub-questions (rounds), sources, and generated notes.
 */

function busy(run: DeepResearchRunState): boolean {
  return run.phase === "planning" || run.phase === "researching" || run.phase === "synthesizing";
}

function activeRunStarted(run: DeepResearchRunState): boolean {
  return busy(run) && run.startedAt > 0;
}

const KIND_ICON: Record<ResearchActivity["kind"], string> = {
  plan: "▤",
  round: "↻",
  subquestion: "→",
  search: "⌕",
  source: "▹",
  note: "✓",
  synthesize: "✎",
  status: "·",
};

const SCOPE_INFO: Record<ResearchContextScope, string> = {
  workspace:
    "Send only what you're looking at: the active note, selected notes, and their direct links (backlinks + outgoing).",
  vault:
    "Also mine the whole vault: notes sharing tags with the picked set and query-term content matches.",
};

function num(lo: number, hi: number, set: (n: number) => void) {
  return (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) set(Math.max(lo, Math.min(hi, Math.round(n))));
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to the legacy WebKit/Tauri clipboard path. */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function saveKitToDisk(text: string, runId: string, completed: boolean): Promise<boolean> {
  if (!IN_TAURI) return false;
  try {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "run";
    return await saveTextFile(
      text,
      {
        title: completed ? "Save completed Deep Research log" : "Save Deep Research troubleshooting kit",
        defaultPath: `mesa-deep-research-${safeRunId}-${completed ? "complete" : "troubleshooting"}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      },
      { save, writeTextFile }
    );
  } catch {
    return false;
  }
}

const GRAPH_NODE_GLYPH: Record<string, string> = {
  query: "?",
  plan: "▤",
  round: "↻",
  subquestion: "→",
  search: "⌕",
  source: "▹",
  note: "✓",
  synthesize: "✎",
};

function ResearchActivityGraph({
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

function ResearchSourceIcon({ source }: { source: ResearchSourcePresentation }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source.faviconUrl]);
  return (
    <span className="dr-source-icon" title={source.siteName} aria-hidden="true">
      {failed ? (
        <span className="dr-source-icon-fallback">{source.initial}</span>
      ) : (
        <img
          src={source.faviconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

// Preserve the existing named exports for internal callers while keeping the
// phase-chip implementation out of this panel's startup module.
export { DeepResearchPhaseChip, DeepResearchPhaseChipWithRun } from "./DeepResearchPhaseChip";

export function DeepResearchPanel({
  piSurfaceAvailable = false,
  runOverride,
  readOnly = false,
}: {
  piSurfaceAvailable?: boolean;
  runOverride?: DeepResearchRunState | null;
  readOnly?: boolean;
}) {
  const storeRun = useAppStore((s) => s.deepResearch);
  const run = runOverride ?? storeRun;
  const vaultPath = useAppStore((s) => s.vaultPath);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const startDeepResearch = useAppStore((s) => s.startDeepResearch);
  const cancelDeepResearch = useAppStore((s) => s.cancelDeepResearch);
  const applyDeepResearch = useAppStore((s) => s.applyDeepResearch);
  const discardDeepResearch = useAppStore((s) => s.discardDeepResearch);
  const openFile = useAppStore((s) => s.openFile);

  const fileCount = useAppStore((s) => s.files.length);
  // Subscribe to the map identity and derive the count in a memo: a selector
  // re-runs on every store `set()` (one per keystroke), and `Object.keys` there
  // rebuilt a 2,400-entry array each time just to read its length.
  const notes = useAppStore((s) => s.notes);
  const noteCount = useMemo(() => Object.keys(notes).length, [notes]);

  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [showDepth, setShowDepth] = useState(false);
  const [copiedKit, setCopiedKit] = useState<"idle" | "copied" | "saved" | "failed">("idle");
  const [watchdogNow, setWatchdogNow] = useState(() => Date.now());
  const activityRef = useRef<HTMLDivElement | null>(null);

  // Secret-scrubbed markdown kit for pasting into a bug report or at an LLM.
  const copyKit = async (completed = false) => {
    const cur = runOverride ?? getStore().deepResearch;
    if (!cur) return;
    let appVersion = "dev";
    if (IN_TAURI) {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        appVersion = await getVersion();
      } catch {
        /* keep "dev" */
      }
    }
    const sessionId = cur.piSessionId ?? currentPiSessionId();
    const input = {
      appVersion,
      userAgent: navigator.userAgent,
      vaultFileCount: fileCount,
      vaultNoteCount: noteCount,
      piSessionLive: Boolean(sessionId),
      agentProvider: settings.agentProvider,
      agentModel: settings.agentModel,
      piSessionTranscript: null as string | null,
      run: cur,
    };
    if (IN_TAURI) {
      if (sessionId) {
        try {
          const snapshot = await invoke<{ data: string }>("terminal_snapshot", { sessionId });
          input.piSessionTranscript = snapshot.data;
        } catch {
          input.piSessionLive = false;
          // The PTY can close as a run finishes; keep the structured export.
        }
      }
    }
    const kit = completed
      ? buildResearchCompletionExport(input)
      : buildResearchTroubleshootingKit(input);
    const copied = await copyText(kit);
    const saved = !copied && (await saveKitToDisk(kit, cur.runId, completed));
    setCopiedKit(copied ? "copied" : saved ? "saved" : "failed");
    setTimeout(() => setCopiedKit("idle"), 1800);
  };

  // Per-run depth (initialized from the persisted default preset).
  const defaultDepth = useMemo(
    () =>
      clampDepth(
        RESEARCH_DEPTH_PRESETS[
          (settings.researchDepth as ResearchDepthPreset) in RESEARCH_DEPTH_PRESETS
            ? (settings.researchDepth as ResearchDepthPreset)
            : "standard"
        ]
      ),
    [settings.researchDepth]
  );
  const [depth, setDepth] = useState<ResearchDepth>(defaultDepth);
  useEffect(() => setDepth(defaultDepth), [defaultDepth]);

  useEffect(() => {
    if (run?.query) setQuery(run.query);
  }, [run?.runId, run?.query]);

  // Invisible stall watchdog. Healthy runs render nothing; after a submitted
  // prompt has produced no new activity for two minutes, React wakes once so
  // the troubleshooting action can appear.
  useEffect(() => {
    const now = Date.now();
    setWatchdogNow(now);
    if (!run || researchTroubleshootingTrigger(run, now)) return;
    if (!run.promptSentAt) return;
    if (run.phase !== "planning" && run.phase !== "researching" && run.phase !== "synthesizing") return;
    const lastActivityAt = run.activity.reduce((latest, activity) => Math.max(latest, activity.at), run.promptSentAt);
    const remaining = lastActivityAt + RESEARCH_TROUBLESHOOTING_IDLE_MS - now;
    const timer = window.setTimeout(
      () => setWatchdogNow(Date.now()),
      Math.max(0, remaining) + 20
    );
    return () => window.clearTimeout(timer);
  }, [run?.runId, run?.phase, run?.promptSentAt, run?.error, run?.activity]);

  // Keep the live activity feed pinned to the bottom while a run streams.
  useEffect(() => {
    const el = activityRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.activity.length]);

  const opList = useMemo(() => run?.changeSet?.ops ?? [], [run?.changeSet]);
  const previewOp = useMemo(() => opList.find((o) => o.relPath === preview) ?? null, [opList, preview]);
  const researchGraph = useMemo(
    () => (run ? <ResearchActivityGraph run={run} openFile={openFile} /> : null),
    [openFile, run]
  );
  const troubleshootingTrigger = run
    ? researchTroubleshootingTrigger(run, watchdogNow)
    : null;

  if (!run) return null;

  const inTauri = IN_TAURI;
  const isBusy = busy(run);
  const showActiveRunControls = activeRunStarted(run);
  const canStart = !isBusy && run.phase !== "applying" && query.trim().length > 0;
  const hasProposal = run.phase === "review" && run.changeSet;
  const claimCounts = run.result
    ? {
        verified: run.result.claims.filter((c) => c.kind === "verified").length,
        inference: run.result.claims.filter((c) => c.kind === "inference").length,
        conflict: run.result.claims.filter((c) => c.kind === "conflict").length,
        unknown: run.result.claims.filter((c) => c.kind === "unknown").length,
      }
    : null;
  const scope: ResearchContextScope =
    settings.researchContextScope === "vault" ? "vault" : "workspace";
  const activePreset = (Object.keys(RESEARCH_DEPTH_PRESETS) as ResearchDepthPreset[]).find((p) => {
    const preset = RESEARCH_DEPTH_PRESETS[p];
    return preset.rounds === depth.rounds &&
      preset.subQuestions === depth.subQuestions &&
      preset.maxSources === depth.maxSources &&
      preset.maxGeneratedNotes === depth.maxGeneratedNotes;
  });

  const applyPreset = (p: ResearchDepthPreset) => {
    setDepth(clampDepth(RESEARCH_DEPTH_PRESETS[p]));
    setSetting("researchDepth", p);
  };
  const queryControls = (
    <div className="dr-query-row">
      {!showActiveRunControls && (
        <>
          <textarea
            className="dr-query"
            placeholder="What should Pi research? (e.g. “How does X relate to the notes I have open?”)"
            value={query}
            rows={2}
            disabled={isBusy || run.phase === "applying"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canStart) {
                e.preventDefault();
                void startDeepResearch(query, { depth, scope, piSurfaceAvailable });
              }
            }}
          />

          <div className="dr-depth-bar">
            <div className="dr-depth-presets" role="group" aria-label="Research depth">
              {(["quick", "standard", "deep"] as ResearchDepthPreset[]).map((p) => (
                <button
                  key={p}
                  className={"dr-preset" + (activePreset === p ? " on" : "")}
                  aria-pressed={activePreset === p}
                  onClick={() => applyPreset(p)}
                  disabled={isBusy || run.phase === "applying"}
                  title={`${p}: ${RESEARCH_DEPTH_PRESETS[p].rounds} rounds, ${RESEARCH_DEPTH_PRESETS[p].subQuestions} sub-questions, ${RESEARCH_DEPTH_PRESETS[p].maxSources} sources, ${RESEARCH_DEPTH_PRESETS[p].maxGeneratedNotes} notes`}
                >
                  {p}
                </button>
              ))}
              <button
                className={"dr-preset dr-tune" + (showDepth ? " on" : "")}
                aria-pressed={showDepth}
                aria-label="Fine-tune research depth"
                onClick={() => setShowDepth((v) => !v)}
                disabled={isBusy || run.phase === "applying"}
                title="Fine-tune depth"
              >
                ⚙
              </button>
            </div>
            <div className="dr-depth-presets" role="group" aria-label="Context scope">
              {(["workspace", "vault"] as ResearchContextScope[]).map((sc) => (
                <button
                  key={sc}
                  className={"dr-preset" + (scope === sc ? " on" : "")}
                  aria-pressed={scope === sc}
                  onClick={() => setSetting("researchContextScope", sc)}
                  disabled={isBusy || run.phase === "applying"}
                  title={SCOPE_INFO[sc]}
                >
                  {sc === "workspace" ? "workspace ctx" : "vault ctx"}
                </button>
              ))}
            </div>
            <div className="dr-actions">
              {!isBusy && run.phase !== "applying" && (
                <button className="btn primary" disabled={!canStart} onClick={() => void startDeepResearch(query, { depth, scope, piSurfaceAvailable })}>
                  {run.phase === "idle" || run.phase === "planning" ? "Start research" : "Run again"}
                </button>
              )}
              {isBusy && (
                <button className="btn" onClick={() => void cancelDeepResearch()}>
                  Cancel
                </button>
              )}
              {troubleshootingTrigger && run.phase !== "error" && (
                <button className="btn" onClick={() => void copyKit()}>
                  {copiedKit === "copied"
                    ? "Copied"
                    : copiedKit === "saved"
                      ? "Saved to file"
                    : copiedKit === "failed"
                      ? "Copy failed"
                      : "Copy troubleshooting kit"}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {showActiveRunControls && (
        <div className="dr-actions dr-active-controls">
          <button className="btn" onClick={() => void cancelDeepResearch()}>
            Cancel
          </button>
          {troubleshootingTrigger && (
            <button className="btn" onClick={() => void copyKit()}>
              {copiedKit === "copied" ? "Copied" : copiedKit === "saved" ? "Saved to file" : copiedKit === "failed" ? "Copy failed" : "Copy troubleshooting kit"}
            </button>
          )}
        </div>
      )}

      {!showActiveRunControls && showDepth && (
        <div className="dr-depth-tune">
          <label>
            Rounds
            <input
              type="number"
              min={DEPTH_LIMITS.rounds.min}
              max={DEPTH_LIMITS.rounds.max}
              value={depth.rounds}
              onChange={num(DEPTH_LIMITS.rounds.min, DEPTH_LIMITS.rounds.max, (n) => setDepth((d) => ({ ...d, rounds: n })))}
            />
          </label>
          <label>
            Sub-questions
            <input
              type="number"
              min={DEPTH_LIMITS.subQuestions.min}
              max={DEPTH_LIMITS.subQuestions.max}
              value={depth.subQuestions}
              onChange={num(DEPTH_LIMITS.subQuestions.min, DEPTH_LIMITS.subQuestions.max, (n) => setDepth((d) => ({ ...d, subQuestions: n })))}
            />
          </label>
          <label>
            Sources
            <input
              type="number"
              min={DEPTH_LIMITS.maxSources.min}
              max={DEPTH_LIMITS.maxSources.max}
              value={depth.maxSources}
              onChange={num(DEPTH_LIMITS.maxSources.min, DEPTH_LIMITS.maxSources.max, (n) => setDepth((d) => ({ ...d, maxSources: n })))}
            />
          </label>
          <label>
            Generated notes
            <input
              type="number"
              min={DEPTH_LIMITS.maxGeneratedNotes.min}
              max={DEPTH_LIMITS.maxGeneratedNotes.max}
              value={depth.maxGeneratedNotes}
              onChange={num(DEPTH_LIMITS.maxGeneratedNotes.min, DEPTH_LIMITS.maxGeneratedNotes.max, (n) => setDepth((d) => ({ ...d, maxGeneratedNotes: n })))}
            />
          </label>
        </div>
      )}
    </div>
  );

  return (
    <div className="dr-root">
      <div className="dr-scroll">
      {!inTauri && (
        <div className="dr-note">
          Deep Research uses the desktop app's Pi agent and browser harness. In the browser demo you can
          prepare a query, but the run itself needs the Mesa desktop app.
        </div>
      )}
      {inTauri && !vaultPath && (
        <div className="dr-note">Open a vault to run Deep Research — it reads and writes notes there.</div>
      )}

      {run.startedAt > 0 && run.phase !== "done" && researchGraph}

      {isBusy && (run.piTurnEnded || run.finishRejection || troubleshootingTrigger) && (
        <div className="dr-note" role="status">
          {run.error || (run.piTurnEnded
            ? `${run.piTurnEnded.reason} No report has been accepted. Continue in Pi or cancel this run; the troubleshooting kit is available below.`
            : run.finishRejection
              ? `Finish attempt ${run.finishRejection.attempt} was rejected. Pi must correct the report before Mesa can offer it for review. No proposed notes have been written.`
              : "No recent research activity. Mesa is keeping this run open; the troubleshooting kit is available below.")}
          {run.finishRejection && (
            <details>
              <summary>Report validation issues</summary>
              <div className="dr-error-body">{run.finishRejection.reason}</div>
            </details>
          )}
        </div>
      )}

      {!isBusy && run.phase !== "error" && run.error && (
        <div className="dr-note" role="alert">{run.error}</div>
      )}

      {/* Live activity feed */}
      {run.activity.length > 0 && run.phase !== "review" && run.phase !== "done" && (
        <div className="dr-activity" ref={activityRef}>
          {run.activity.map((a, i) => (
            <div key={i} className={"dr-act dr-act-" + a.kind + (a.observed ? " dr-act-observed" : "")}>
              <span className="dr-act-icon">{KIND_ICON[a.kind]}</span>
              <span className="dr-act-msg">
                {a.kind === "source" && a.sourceUrl ? (
                  <>
                    Reading <span className="dr-act-src">{a.sourceTitle || a.sourceUrl}</span>
                  </>
                ) : (
                  <>{a.round ? `Round ${a.round}: ` : ""}{a.message}</>
                )}
              </span>
            </div>
          ))}
          {isBusy && !run.piTurnEnded && <div className="dr-act dr-act-live">Working…</div>}
        </div>
      )}

      {/* Live report assembly. Pi sends a bounded snapshot after each major
          synthesis section so the user can watch the deliverable take shape. */}
      {run.reportDraft && isBusy && (
        <div className="dr-draft">
          <div className="dr-map-title">{run.piTurnEnded || run.finishRejection ? "Report draft — not accepted" : "Report being assembled"}</div>
          <pre className="dr-draft-body">{run.reportDraft}</pre>
        </div>
      )}

      {/* Confidence snapshot (appears as soon as a result exists) */}
      {claimCounts && run.phase !== "done" && (
        <div className="dr-confidence">
          <span className="dr-conf dr-conf-verified">✓ {claimCounts.verified} verified</span>
          <span className="dr-conf dr-conf-inference">~ {claimCounts.inference} inference</span>
          <span className="dr-conf dr-conf-conflict">⚡ {claimCounts.conflict} disagreement</span>
          <span className="dr-conf dr-conf-unknown">? {claimCounts.unknown} unknown</span>
        </div>
      )}

      {/* Error */}
      {run.phase === "error" && run.error && (
        <div className="dr-error" role="alert">
          <div className="dr-error-title">Deep Research hit a problem</div>
          <div className="dr-error-body">{run.error}</div>
          {!readOnly && <div className="dr-error-actions">
            {troubleshootingTrigger && (
              <button className="btn" onClick={() => void copyKit()}>
                {copiedKit === "copied"
                  ? "Copied"
                  : copiedKit === "saved"
                    ? "Saved to file"
                  : copiedKit === "failed"
                    ? "Copy failed"
                    : "Copy troubleshooting kit"}
              </button>
            )}
            <button className="btn" onClick={() => discardDeepResearch()}>
              Dismiss
            </button>
          </div>}
        </div>
      )}

      {run.phase === "cancelled" && (
        <div className="dr-note">Research cancelled. Nothing was written to the vault.</div>
      )}

      {/* Review: proposed change set */}
      {hasProposal && run.changeSet && (
        <div className="dr-review">
          <div className="dr-review-head">
            <span>
              Proposed changes — {run.changeSet.createdRelPaths.length} new note
              {run.changeSet.createdRelPaths.length === 1 ? "" : "s"}
              {run.changeSet.updatedRelPaths.length > 0 &&
                `, ${run.changeSet.updatedRelPaths.length} update${run.changeSet.updatedRelPaths.length === 1 ? "" : "s"}`}
            </span>
            <span className="dr-review-folder">folder: {run.changeSet.folder}/</span>
          </div>
          <div className="dr-completion-export">
              <span>Research is complete. Capture the full action log when you are ready to share it.</span>
              <button className="btn" onClick={() => void copyKit(true)}>
                {copiedKit === "copied"
                  ? "Copied"
                  : copiedKit === "saved"
                    ? "Saved to file"
                    : copiedKit === "failed"
                      ? "Copy failed"
                      : "Copy research trace"}
                </button>
          </div>

          {run.changeSet.skippedDuplicates.length > 0 && (
            <div className="dr-skips">
              Skipped {run.changeSet.skippedDuplicates.length} duplicate
              {run.changeSet.skippedDuplicates.length === 1 ? "" : "s"} (already in the vault):
              {run.changeSet.skippedDuplicates.slice(0, 4).map((s) => (
                <span key={s.relPath} className="dr-chip" title={s.reason}>
                  {s.title}
                </span>
              ))}
            </div>
          )}

          <div className="dr-ops">
            <div className="dr-ops-list">
              {opList.map((op) => (
                <button
                  key={op.relPath + op.kind}
                  className={"dr-op" + (preview === op.relPath ? " on" : "")}
                  onClick={() => setPreview(preview === op.relPath ? null : op.relPath)}
                >
                  <span className={"dr-op-kind dr-op-" + op.kind}>{op.kind === "create" ? "+" : "~"}</span>
                  <span className="dr-op-rel">{op.relPath}</span>
                </button>
              ))}
            </div>
            {previewOp && (
              <div className="dr-preview">
                <div className="dr-preview-head">{previewOp.relPath}</div>
                <pre className="dr-preview-body">{previewOp.content}</pre>
              </div>
            )}
          </div>

          {!readOnly && <div className="dr-apply-row">
            <button className="btn primary" onClick={() => void applyDeepResearch()}>
              Apply {opList.length} change{opList.length === 1 ? "" : "s"}
            </button>
            <button className="btn" onClick={() => discardDeepResearch()}>
              Discard
            </button>
            <span className="dr-apply-hint">
              All-or-nothing verified writes; existing notes are version-checked first.
            </span>
          </div>}
        </div>
      )}

      {run.phase === "applying" && <div className="dr-note">Writing notes with verified atomic writes…</div>}

      {/* Done */}
      {run.phase === "done" && (
        <div className="dr-done">
          <div className="dr-done-title">
            Applied {run.appliedRelPaths.length} change{run.appliedRelPaths.length === 1 ? "" : "s"} — the graph
            now includes the new notes and links.
          </div>
          <div className="dr-done-list">
            {run.appliedRelPaths.map((rel) => (
              <button key={rel} className="dr-op" onClick={() => void openFile(rel)}>
                <span className="dr-op-rel">{rel}</span>
              </button>
            ))}
          </div>
          <div className="dr-completion-export">
              <span>Completed run log and troubleshooting kit</span>
              <button className="btn" onClick={() => void copyKit(true)}>
                {copiedKit === "copied"
                  ? "Copied"
                  : copiedKit === "saved"
                    ? "Saved to file"
                    : copiedKit === "failed"
                      ? "Copy failed"
                      : "Copy research trace"}
                </button>
          </div>
           {!readOnly && <div className="dr-apply-row">
             <button className="btn" onClick={() => discardDeepResearch()}>
               Close
             </button>
           </div>}
        </div>
      )}
      </div>

      {!readOnly && queryControls}
      {readOnly && troubleshootingTrigger && (
        <div className="dr-query-row">
          <div className="dr-actions dr-active-controls">
            <button className="btn" onClick={() => void copyKit()}>
              {copiedKit === "copied" ? "Copied" : copiedKit === "saved" ? "Saved to file" : copiedKit === "failed" ? "Copy failed" : "Copy troubleshooting kit"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
