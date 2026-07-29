import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, getStore } from "../store";
import type { DeepResearchRunState } from "../store";
import { IN_TAURI } from "../lib/vault";
import {
  RESEARCH_DEPTH_PRESETS,
  DEPTH_LIMITS,
  clampDepth,
  buildResearchGraph,
  presentResearchSource,
  type ResearchContextScope,
  type ResearchDepth,
  type ResearchDepthPreset,
  type ResearchActivity,
  type ResearchSourcePresentation,
} from "../lib/deepResearch";
import {
  buildResearchTroubleshootingKit,
  RESEARCH_TROUBLESHOOTING_IDLE_MS,
  researchTroubleshootingTrigger,
} from "../lib/deepResearchDiagnostics";
import { currentPiSessionId } from "../lib/deepResearchRun";

/**
 * Deep Research surface — the single UI for a Deep Research run, mounted from
 * both launch points (the Steam-overlay dock window and the Pi agent panel).
 * It reads and drives the ONE shared `deepResearch` store run; there is no
 * per-surface state machine.
 *
 * The panel is built for VISIBILITY: the user watches the agent work, not a
 * single-word status. It shows the sub-question plan (with the active one
 * highlighted), every source being read with a live reading/done status, a
 * scrolling activity feed of what the agent is doing right now, the
 * confidence breakdown of the claims it has gathered, and finally the full
 * proposed change set with a preview before anything touches the vault.
 *
 * Thoroughness is customizable: a depth preset (quick / standard / deep) plus
 * per-run controls for sub-questions (rounds), sources, and generated notes.
 */

function phaseLabel(run: DeepResearchRunState): string {
  switch (run.phase) {
    case "idle": return "Ready";
    case "planning": return run.launchStage === "starting-pi" || run.launchStage === "restarting-pi"
      ? "Starting Pi…"
      : "Planning sub-questions…";
    case "researching": return run.launchStage === "waiting-for-model"
      ? "Waiting for Pi…"
      : "Researching sources…";
    case "synthesizing": return "Writing notes…";
    case "review": return "Review proposed changes";
    case "applying": return "Applying changes…";
    case "done": return "Done";
    case "cancelled": return "Cancelled";
    case "error": return "Error";
  }
}

function busy(run: DeepResearchRunState): boolean {
  return run.phase === "planning" || run.phase === "researching" || run.phase === "synthesizing";
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

function ResearchActivityGraph({ run }: { run: DeepResearchRunState }) {
  const graph = buildResearchGraph(run.query, run.activity);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <div className="dr-research-graph">
      <div className="dr-map-title">
        Live evidence graph · {Math.max(0, graph.nodes.length - 1)} actual actions
        {graph.omitted ? ` · ${graph.omitted} older actions omitted from view` : ""}
      </div>
      <div className="dr-research-graph-scroll">
        <svg
          className="dr-research-graph-svg"
          width={graph.width}
          height={graph.height}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          role="img"
          aria-label="Live Deep Research evidence graph"
        >
          <g className="dr-research-graph-edges">
            {graph.edges.map((edge) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;
              const sameColumn = source.x === target.x;
              return (
                <line
                  key={edge.id}
                  x1={source.x + (sameColumn ? 65 : 128)}
                  y1={source.y + source.height / 2}
                  x2={target.x + (sameColumn ? 65 : 0)}
                  y2={target.y + target.height / 2}
                />
              );
            })}
          </g>
          <g className="dr-research-graph-nodes">
            {graph.nodes.map((node) => (
              <g
                key={node.id}
                className={
                  `dr-graph-node dr-graph-node-${node.kind}` +
                  (node.observed ? " observed" : " reported") +
                  (node.latest ? " latest" : "")
                }
                transform={`translate(${node.x},${node.y})`}
              >
                <title>{node.label}</title>
                <rect width="130" height={node.height} rx="8" />
                <circle cx="11" cy="11" r="3" />
                <text x="19" y="13" className="dr-graph-kind">{node.kind}</text>
                {node.lines.map((line, i) => (
                  <text key={i} x="8" y={25 + i * 11} className="dr-graph-label">{line}</text>
                ))}
              </g>
            ))}
          </g>
        </svg>
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

/**
 * Live phase chip for the run, rendered by each HOST's single title bar
 * (the Steam-overlay window bar and the Pi research wing bar). The panel
 * itself renders no header — a second in-panel title would stack two title
 * bars, the exact chrome divergence the Pi windows were unified away from.
 */
export function DeepResearchPhaseChip() {
  const run = useAppStore((s) => s.deepResearch);
  if (!run) return null;
  return <span className={"dr-phase dr-phase-" + run.phase}>{phaseLabel(run)}</span>;
}

export function DeepResearchPanel({ piSurfaceAvailable = false }: { piSurfaceAvailable?: boolean }) {
  const run = useAppStore((s) => s.deepResearch);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const startDeepResearch = useAppStore((s) => s.startDeepResearch);
  const cancelDeepResearch = useAppStore((s) => s.cancelDeepResearch);
  const applyDeepResearch = useAppStore((s) => s.applyDeepResearch);
  const discardDeepResearch = useAppStore((s) => s.discardDeepResearch);
  const openFile = useAppStore((s) => s.openFile);

  const fileCount = useAppStore((s) => s.files.length);
  const noteCount = useAppStore((s) => Object.keys(s.notes).length);

  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [showDepth, setShowDepth] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [copiedKit, setCopiedKit] = useState<"idle" | "copied" | "failed">("idle");
  const [copiedSource, setCopiedSource] = useState<string | null>(null);
  const [watchdogNow, setWatchdogNow] = useState(() => Date.now());
  const activityRef = useRef<HTMLDivElement | null>(null);

  // Secret-scrubbed markdown kit for pasting into a bug report or at an LLM.
  const copyKit = async () => {
    const cur = getStore().deepResearch;
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
    const kit = buildResearchTroubleshootingKit({
      appVersion,
      userAgent: navigator.userAgent,
      vaultFileCount: fileCount,
      vaultNoteCount: noteCount,
      piSessionLive: Boolean(currentPiSessionId()),
      agentProvider: settings.agentProvider,
      agentModel: settings.agentModel,
      run: cur,
    });
    const copied = await copyText(kit);
    setCopiedKit(copied ? "copied" : "failed");
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
  useEffect(() => {
    setContextOpen((run?.startedAt ?? 0) <= 0);
  }, [run?.runId]);

  // Invisible initial-stall watchdog. Healthy runs render nothing; after a
  // submitted prompt has produced zero real actions for two minutes, React
  // wakes once so the troubleshooting action can appear.
  useEffect(() => {
    const now = Date.now();
    setWatchdogNow(now);
    if (!run || researchTroubleshootingTrigger(run, now)) return;
    if (!run.promptSentAt) return;
    if (run.activity.some((activity) => activity.kind !== "status")) return;
    if (run.phase !== "planning" && run.phase !== "researching" && run.phase !== "synthesizing") return;
    const remaining = run.promptSentAt + RESEARCH_TROUBLESHOOTING_IDLE_MS - now;
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
  const researchGraph = useMemo(() => (run ? <ResearchActivityGraph run={run} /> : null), [run]);
  const troubleshootingTrigger = run
    ? researchTroubleshootingTrigger(run, watchdogNow)
    : null;

  if (!run) return null;

  const inTauri = IN_TAURI;
  const isBusy = busy(run);
  const canStart = !isBusy && run.phase !== "applying" && query.trim().length > 0;
  const hasProposal = run.phase === "review" && run.changeSet;
  const doneSources = run.sources.filter((s) => s.status === "done").length;
  const savedSources = run.sources.filter((s) => s.archiveStatus === "saved").length;
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
  const copySourceLink = async (url: string) => {
    if (!(await copyText(url))) return;
    setCopiedSource(url);
    window.setTimeout(() => setCopiedSource((current) => current === url ? null : current), 1800);
  };

  return (
    <div className="dr-root">
      {!inTauri && (
        <div className="dr-note">
          Deep Research uses the desktop app's Pi agent and browser harness. In the browser demo you can
          prepare a query, but the run itself needs the Mesa desktop app.
        </div>
      )}
      {inTauri && !vaultPath && (
        <div className="dr-note">Open a vault to run Deep Research — it reads and writes notes there.</div>
      )}

      {/* Query + depth */}
      <div className="dr-query-row">
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
                onClick={() => applyPreset(p)}
                disabled={isBusy || run.phase === "applying"}
                title={`${p}: ${RESEARCH_DEPTH_PRESETS[p].rounds} rounds, ${RESEARCH_DEPTH_PRESETS[p].subQuestions} sub-questions, ${RESEARCH_DEPTH_PRESETS[p].maxSources} sources, ${RESEARCH_DEPTH_PRESETS[p].maxGeneratedNotes} notes`}
              >
                {p}
              </button>
            ))}
            <button
              className={"dr-preset dr-tune" + (showDepth ? " on" : "")}
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
            {troubleshootingTrigger && run.phase !== "error" && (
              <button className="btn" onClick={() => void copyKit()}>
                {copiedKit === "copied"
                  ? "Copied"
                  : copiedKit === "failed"
                    ? "Copy failed"
                    : "Copy troubleshooting kit"}
              </button>
            )}
            {isBusy && (
              <button className="btn" onClick={() => void cancelDeepResearch()}>
                Cancel
              </button>
            )}
          </div>
        </div>

        {showDepth && (
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

      {/* Context summary */}
      {run.context && (
        <div
          key={`${run.runId}:${run.startedAt > 0 ? "running" : "idle"}`}
          className="dr-context"
        >
          <button
            type="button"
            className="dr-context-title"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((open) => !open)}
          >
            <span>Context sent to Pi — {run.context.summary} · {run.context.scope} scope</span>
            <span className="dr-context-toggle">{contextOpen ? "Hide" : "Details"}</span>
          </button>
          {contextOpen && <div className="dr-context-body">
            <div className="dr-context-notes">
              {run.context.notes.slice(0, 10).map((n) => (
                <span key={n.relPath} className="dr-chip" title={n.via.join(", ")}>
                  {n.relPath}
                </span>
              ))}
              {run.context.notes.length > 10 && (
                <span className="dr-chip dr-chip-more">+{run.context.notes.length - 10} more</span>
              )}
            </div>
            {run.context.notes.length === 0 && run.context.scope === "workspace" && (
              <div className="dr-context-trunc">
                No workspace notes included — open or select a note before starting, or switch to
                vault ctx to mine the whole vault.
              </div>
            )}
            {run.context.truncated && (
              <div className="dr-context-trunc">
                Bounded for responsiveness; {run.context.omittedNotes} related note
                {run.context.omittedNotes === 1 ? "" : "s"} omitted.
              </div>
            )}
            {run.context.notes.some((n) => n.redacted) && (
              <div className="dr-context-trunc">
                Credential-shaped values were redacted before this context was sent to Pi.
              </div>
            )}
          </div>}
        </div>
      )}

      {run.startedAt > 0 && run.phase !== "done" && researchGraph}

      {/* Live research map: sub-questions + sources */}
      {(run.sources.length > 0 || (run.phase !== "done" && run.subQuestions.length > 0)) && (
        <div className="dr-map">
          {run.subQuestions.length > 0 && run.phase !== "done" && (
            <div className="dr-subq">
              <div className="dr-map-title">
                Sub-questions · round {Math.max(1, run.currentRound)}/{run.depth.rounds}
              </div>
              {run.subQuestions.map((q, i) => {
                const active = run.currentSubQuestion === q;
                const passed =
                  run.currentSubQuestion != null &&
                  run.subQuestions.indexOf(run.currentSubQuestion) > i;
                return (
                  <div key={i} className={"dr-subq-item" + (active ? " active" : "") + (passed ? " done" : "")}>
                    <span className="dr-subq-mark">{passed ? "✓" : active ? "→" : `${i + 1}`}</span>
                    <span className="dr-subq-text">{q}</span>
                  </div>
                );
              })}
            </div>
          )}
          {run.sources.length > 0 && (
            <div className="dr-sources">
              <div className="dr-map-title">
                Sources · {doneSources}/{run.sources.length} read
                {savedSources > 0 ? ` · ${savedSources} saved` : ""}
              </div>
              <div className="dr-source-list">
                {run.sources.map((s) => {
                  const source = presentResearchSource(s.url, s.title);
                  if (!source) return null;
                  return (
                    <div key={s.url} className={"dr-source dr-source-" + s.status}>
                      <ResearchSourceIcon source={source} />
                      <div className="dr-source-body">
                        <div className="dr-source-meta">
                          <span className="dr-source-site">{source.siteName}</span>
                          <span
                            className="dr-source-status"
                            title={s.archiveError}
                          >
                            {s.archiveStatus === "saving"
                              ? "Saving local copy"
                              : s.archiveStatus === "saved"
                                ? s.archiveKind === "link" ? "Link saved" : "Saved locally"
                                : s.archiveStatus === "failed"
                                  ? "Archive failed"
                                  : s.status === "done" ? "Read" : "Reading"}
                          </span>
                        </div>
                        <div className="dr-source-title">{source.pageTitle}</div>
                        <div className="dr-source-actions">
                          <button
                            type="button"
                            className="dr-source-link"
                            title={`Copy ${source.url}`}
                            onClick={() => void copySourceLink(source.url)}
                          >
                            {copiedSource === source.url ? "Copied link" : `Copy link · ${source.host}`}
                          </button>
                          {s.archiveStatus === "saved" && s.archiveRelPath && (
                            <button
                              type="button"
                              className="dr-source-link dr-source-open"
                              title={s.archiveRelPath}
                              onClick={() => void openFile(s.archiveRelPath!)}
                            >
                              Open saved page
                            </button>
                          )}
                        </div>
                      </div>
                      <span className="dr-source-mark" aria-hidden="true">
                        {s.archiveStatus === "failed"
                          ? "!"
                          : s.archiveStatus === "saving"
                            ? "↓"
                            : s.archiveStatus === "saved"
                              ? "▣"
                              : s.status === "done" ? "✓" : "…"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
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
          {isBusy && <div className="dr-act dr-act-live">Working…</div>}
        </div>
      )}

      {/* Live report assembly. Pi sends a bounded snapshot after each major
          synthesis section so the user can watch the deliverable take shape. */}
      {run.reportDraft && isBusy && (
        <div className="dr-draft">
          <div className="dr-map-title">Report being assembled</div>
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
          <div className="dr-error-actions">
            {troubleshootingTrigger && (
              <button className="btn" onClick={() => void copyKit()}>
                {copiedKit === "copied"
                  ? "Copied"
                  : copiedKit === "failed"
                    ? "Copy failed"
                    : "Copy troubleshooting kit"}
              </button>
            )}
            <button className="btn" onClick={() => discardDeepResearch()}>
              Dismiss
            </button>
          </div>
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

          <div className="dr-apply-row">
            <button className="btn primary" onClick={() => void applyDeepResearch()}>
              Apply {opList.length} change{opList.length === 1 ? "" : "s"}
            </button>
            <button className="btn" onClick={() => discardDeepResearch()}>
              Discard
            </button>
            <span className="dr-apply-hint">
              All-or-nothing verified writes; existing notes are version-checked first.
            </span>
          </div>
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
          <div className="dr-apply-row">
            <button className="btn" onClick={() => discardDeepResearch()}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
