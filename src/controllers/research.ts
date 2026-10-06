import {
  bumpActivityAmount
} from "../lib/activity";
import {
  BackgroundWorkCancelledError,
  backgroundWork,
  type BackgroundWorkHandle,
} from "../lib/backgroundWorkGovernor";
import { forkContentCache } from "../lib/documentWorkingSet";
import { extractAliases, extractLinks, extractTags } from "../lib/markdownExtract";
import {
  IN_TAURI,
  writeVaultTextFile
} from "../lib/vault";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DeepResearchContext,
  DeepResearchResult,
  ResearchActivity,
  ResearchContextScope
} from "../lib/deepResearch";
import { isDeepResearchBindingCurrent } from "../lib/deepResearchBinding";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  clampDepth,
  limitsForDepth,
  truncateUtf8,
  utf8ByteLength,
} from "../lib/deepResearchConfig";
import type { ResearchFinishReply } from "../lib/deepResearchRun";
import { explainResearchTimeout } from "../lib/deepResearchTimeout";
import { activityForNavigation, canonicalizeSourceUrl } from "../lib/deepResearchUrls";
import {
  getPiSessionSnapshot,
  requestSharedPiRestart
} from "../lib/piSessionBridge";
import {
  archiveWebPage,
  queueAcceptedResearchSources,
  researchArchiveRelPaths,
  type ArchiveFetchedPage,
} from "../lib/webArchive";
const loadDeepResearch = () => import("../lib/deepResearch");
const createRunId = () => `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const currentPiSessionId = () => getPiSessionSnapshot().sessionId;
const loadDeepResearchRun = () => import("../lib/deepResearchRun");

import type { StoreApi } from "zustand";
import type { AppState, DeepResearchRunState } from "../store";
type Port = { get: () => AppState; set: StoreApi<AppState>["setState"] };

interface Dependencies extends Port {
  getGeneration: () => number;
  registerExternalFile: (path: string, isCurrent?: () => boolean) => Promise<void>;
  refreshMissingExternalFiles: (root: string, isCurrent?: () => boolean) => Promise<void>;
}
export function createResearchController({ get, set, getGeneration, registerExternalFile, refreshMissingExternalFiles }: Dependencies) {
  // --- Deep Research run bookkeeping (controller-owned, not React state). -------
  let drSeq = 0;
  let listenerGeneration = 0;
  let drUnlisten: (() => void) | null = null;
  let drNavUnlistens: (() => void)[] = [];
  let drLastObservedUrl: string | null = null;
  let drLastEventAt = 0;
  let drTimeout: ReturnType<typeof setTimeout> | undefined;
  let drFinishRejectionCount = 0;
  let drRepairPromptedAttempt = 0;
  let drContextHandle: BackgroundWorkHandle<DeepResearchContext> | null = null;
  // INACTIVITY window, not a whole-run budget: a slow provider that keeps
  // reporting progress (or keeps browsing) is never killed mid-run; the run
  // fails only after this long with zero progress AND zero observed browsing.
  const DR_TIMEOUT_MS = 6 * 60 * 1000;
  const DR_PI_STARTUP_WAIT_MS = 15 * 1000;

  const drPatch = (patch: Partial<DeepResearchRunState>) => {
    const cur = get().deepResearch;
    if (cur) set({ deepResearch: { ...cur, ...patch } });
  };

  const researchRunIsCurrent = (
    runId: string,
    vaultRoot: string | null,
    vaultGeneration: number
  ): boolean => {
    const cur = get().deepResearch;
    return Boolean(
      cur &&
      isDeepResearchBindingCurrent(
        cur,
        runId,
        vaultRoot,
        vaultGeneration,
        get().vaultPath,
        getGeneration()
      )
    );
  };

  const drPatchSource = (
    runId: string,
    sourceUrl: string,
    patch: Partial<DeepResearchRunState["sources"][number]>
  ): boolean => {
    const cur = get().deepResearch;
    if (!cur || cur.runId !== runId) return false;
    const index = cur.sources.findIndex((source) => source.url === sourceUrl);
    if (index < 0) return false;
    const sources = cur.sources.slice();
    sources[index] = { ...sources[index], ...patch };
    set({ deepResearch: { ...cur, sources } });
    return true;
  };

  /**
   * Save only the final validated source set. Merely visited/search-result
   * pages never reach this queue. Archiving is independent of proposal apply:
   * it preserves the evidence that produced the proposal, while note changes
   * still wait for explicit review.
   */
  async function drArchiveAcceptedSources(
    runId: string,
    root: string,
    vaultGeneration: number,
    sources: DeepResearchResult["sources"],
    archiveStartedAt: number
  ): Promise<void> {
    const isCurrent = () =>
      researchRunIsCurrent(runId, root, vaultGeneration) &&
      ["review", "applying", "done"].includes(get().deepResearch?.phase ?? "");
    const relPaths = researchArchiveRelPaths(
      sources.map((source) => source.url),
      archiveStartedAt
    );
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < sources.length) {
        if (!isCurrent()) return;
        const index = nextIndex++;
        const source = sources[index];
        const relPath = relPaths[index];
        if (!source || !relPath) continue;
        try {
          const archived = await archiveWebPage(
            source.url,
            {
              fetchPage: (url) =>
                invoke<ArchiveFetchedPage>("browse_fetch", { url }),
              writeText: async (targetRelPath, html) => {
                // The fetch can finish after a vault switch or discarded run.
                // Re-check before starting a new verified write.
                if (!isCurrent()) {
                  throw new Error("Deep Research archive no longer belongs to the active run.");
                }
                await writeVaultTextFile(root, targetRelPath, html, {
                  expectedMissing: true,
                });
              },
            },
            { relPath }
          );
          if (!isCurrent()) return;
          bumpActivityAmount(
            archived.relPath,
            1.2,
            "create",
            archived.linkRecord
              ? "Deep Research saved a source link"
              : "Deep Research archived an accepted source"
          );
          // Never register a file against a different vault if the user
          // switches vaults while the background queue is finishing.
          await registerExternalFile(archived.relPath, isCurrent);
          if (isCurrent()) {
            drPatchSource(runId, source.url, {
              archiveStatus: "saved",
              archiveRelPath: archived.relPath,
              archiveKind: archived.linkRecord ? "link" : "page",
              archiveError: archived.warning,
            });
          }
        } catch (error) {
          if (isCurrent()) {
            drPatchSource(runId, source.url, {
              archiveStatus: "failed",
              archiveError:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    };
    const workerCount = Math.min(3, sources.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async function drStopListening() {
    listenerGeneration++;
    if (drTimeout) clearTimeout(drTimeout);
    drTimeout = undefined;
    const uns = [drUnlisten, ...drNavUnlistens];
    drUnlisten = null;
    drNavUnlistens = [];
    for (const un of uns) {
      if (!un) continue;
      try {
        un();
      } catch {
        /* ignore */
      }
    }
  }

  /** Finalize a run from the Pi extension's finish payload: validate the
   *  structured result (the trust boundary — model output is data), build the
   *  deterministic change set, and move to the review phase. */
  async function drFinish(runId: string, rawResult: unknown): Promise<ResearchFinishReply> {
    const cur = get().deepResearch;
    const stale: ResearchFinishReply = { status: "stopped", message: "This research run is no longer active. No result was accepted." };
    if (!cur || cur.runId !== runId || !["planning", "researching", "synthesizing"].includes(cur.phase)) return stale;
    if (!researchRunIsCurrent(runId, cur.vaultRoot, cur.vaultGeneration)) {
      void drStopListening();
      drPatch({
        phase: "cancelled",
        launchStage: "cancelled",
        changeSet: null,
        error: "Deep Research was cancelled because the active vault changed.",
      });
      return stale;
    }
    const rejectFinishForRetry = (reason: string): ResearchFinishReply => {
      drFinishRejectionCount += 1;
      drPatch({
        finishRejection: {
          attempt: drFinishRejectionCount, reason, at: Date.now(),
          reportMarkdown: get().deepResearch?.reportDraft ?? "",
        }
      });
      const terminal = drFinishRejectionCount >= 3;
      if (terminal) {
        void drStopListening();
        drPatch({
          phase: "error",
          launchStage: "error",
          error:
            "Deep Research stopped after repeated incomplete finish attempts.\n" +
            reason +
            "\nMesa did not accept a report or write proposed notes. Copy the troubleshooting kit to inspect the report and validation issues.",
          activity: [
            ...(get().deepResearch?.activity ?? []),
            { kind: "status" as const, message: "Research stopped after three rejected finish attempts; trace is ready to copy.", at: Date.now() },
          ].slice(-300),
        });
        return { status: "stopped", message: get().deepResearch?.error ?? reason };
      }
      const message =
        "Mesa did not accept the Deep Research finish payload yet. Continue the same run; do not call deep_research_finish again until you have fixed every item below.\n" +
        reason +
        "\nRepair report structure using the evidence already gathered; browse again only for missing evidence. Under ## Findings copy each result.subQuestions entry verbatim as a ### heading. Every one of those subsections MUST contain a literal Markdown URL from the exact Mesa-observed source URL list above; a source title alone is not a citation. Do not cite an unobserved URL or invent support for unresolved gaps. Resubmit the complete result, or call deep_research_blocked with the exact obstacle.";
      drPatch({
        phase: "researching",
        launchStage: "active",
        error: null,
        piTurnEnded: undefined,
        activity: [
          ...(get().deepResearch?.activity ?? []),
          { kind: "status" as const, message: `Finish rejected; asking Pi to continue: ${reason.replace(/\n/g, " ")}`, at: Date.now() },
        ].slice(-300),
      });
      return { status: "rejected", message };
    };
    drPatch({ launchStage: "finishing" });
    if (!rawResult || typeof rawResult !== "object") {
      return rejectFinishForRetry("- The finish payload was not a structured object.");
    }
    const limits = limitsForDepth(DEFAULT_DEEP_RESEARCH_LIMITS, cur.depth);
    const research = await loadDeepResearch();
    const result = research.validateResearchResult(rawResult as DeepResearchResult, limits);
    drPatch({ reportDraft: result.report.markdown });
    if (!result.report.markdown.trim()) {
      return rejectFinishForRetry("- report.markdown is empty after validation.");
    }
    const seenSourceUrls = new Set(
      cur.sources
        .filter((source) => source.observed === true)
        .map((source) => canonicalizeSourceUrl(source.url) ?? source.url)
    );
    const unseenSources = result.sources
      .map((source) => source.url)
      .filter((url) => !seenSourceUrls.has(canonicalizeSourceUrl(url) ?? url));
    const observedSourceList = [...seenSourceUrls];
    const qualityIssues = [
      ...research.researchReportQualityIssues(result, cur.depth),
      ...(unseenSources.length
        ? [
          `result cites ${unseenSources.length} source(s) that Mesa did not observe during the run`,
          `exact unobserved source URLs: ${unseenSources.join(", ")}`,
          `exact Mesa-observed source URLs: ${observedSourceList.length ? observedSourceList.join(", ") : "(none)"}`,
        ]
        : []),
    ];
    if (qualityIssues.length) {
      return rejectFinishForRetry(qualityIssues.map((issue) => `- ${issue}`).join("\n"));
    }
    const folder = get().settings.researchFolder || "Research";
    const changeSet = research.buildChangeSet({
      runId,
      result,
      folder,
      existingFiles: get().files,
      notes: get().notes,
      content: get().contentCache,
      now: new Date(),
      limits,
    });
    const finalSources = queueAcceptedResearchSources(
      cur.sources,
      result.sources
    );
    const root = get().vaultPath;
    const archiveStartedAt = Date.now();
    void drStopListening();
    drPatch({
      phase: "review",
      launchStage: "review",
      result,
      changeSet,
      subQuestions: result.subQuestions && result.subQuestions.length ? result.subQuestions : cur.subQuestions,
      currentSubQuestion: null,
      currentRound: cur.depth.rounds,
      sources: finalSources,
      reportDraft: result.report.markdown,
      finishRejection: undefined,
      piTurnEnded: undefined,
    });
    if (root && IN_TAURI && result.sources.length > 0) {
      void drArchiveAcceptedSources(
        runId,
        root,
        cur.vaultGeneration,
        result.sources,
        archiveStartedAt
      );
    }
    return { status: "accepted", message: "Mesa accepted the Deep Research report. Proposed note changes are ready for the user's review; they have not been applied. Accepted source archiving is handled separately by Mesa." };
  }

  async function drStartListening(runId: string) {
    const stopped = drStopListening();
    const listeningGeneration = listenerGeneration;
    await stopped;
    const current = () => listenerGeneration === listeningGeneration;
    const researchRun = await loadDeepResearchRun();
    if (!current()) return;
    const unlisten = await researchRun.listenDeepResearch(async (evt) => {
      const cur = get().deepResearch;
      if (
        !cur ||
        cur.runId !== runId ||
        evt.runId !== runId ||
        !researchRunIsCurrent(runId, cur.vaultRoot, cur.vaultGeneration) ||
        !["planning", "researching", "synthesizing"].includes(cur.phase)
      ) {
        if (evt.kind === "finish" && evt.requestId) {
          void researchRun.respondResearchFinish(evt.runId, evt.requestId, {
            status: "stopped", message: "This run is no longer active; no further result was accepted.",
          }).catch(() => undefined);
        }
        return;
      }
      drLastEventAt = Date.now();
      if (evt.kind === "agent-start" || evt.kind === "agent-end") {
        const ended = evt.kind === "agent-end";
        const reason = (evt.reason ?? "Pi ended its turn without an accepted report.").slice(0, 4000);
        const rejection = get().deepResearch?.finishRejection;
        drPatch({
          piTurnEnded: ended ? { reason, at: Date.now() } : undefined,
          activity: [...cur.activity, {
            kind: "status" as const, message: ended ? reason : "Pi started a research turn.", at: Date.now(),
          }].slice(-300),
        });
        if (ended && rejection && rejection.attempt < 3 && rejection.attempt > drRepairPromptedAttempt) {
          const sid = currentPiSessionId();
          if (sid) {
            drRepairPromptedAttempt = rejection.attempt;
            const repairPrompt =
              "The previous Deep Research turn ended before Mesa accepted the report. Continue the same run now.\n" +
              rejection.reason +
              "\nUse the evidence already gathered. Repair every listed issue, include a literal Markdown URL from the exact Mesa-observed source URL list in every ## Findings ### subsection, and call deep_research_finish again with the complete structured result. Do not stop with prose; call deep_research_blocked only if no trustworthy repair is possible.";
            drPatch({
              launchStage: "active",
              piTurnEnded: undefined,
              activity: [
                ...(get().deepResearch?.activity ?? []),
                { kind: "status" as const, message: `Pi ended after rejection; sending repair attempt ${rejection.attempt + 1}…`, at: Date.now() },
              ].slice(-300),
            });
            void researchRun.sendResearchPrompt(sid, repairPrompt).catch((error) => {
              if (get().deepResearch?.runId !== runId) return;
              void drStopListening();
              drPatch({ phase: "error", launchStage: "error", error: `Could not send finish corrections to Pi: ${String(error)}` });
            });
          }
        }
      } else if (evt.kind === "progress") {
        const phase = evt.phase ?? "researching";
        const message = (evt.message ?? "").slice(0, 800);
        const allowedKinds: ResearchActivity["kind"][] = [
          "plan", "round", "subquestion", "search", "source", "note", "synthesize", "status",
        ];
        const kind = allowedKinds.includes(evt.activityKind as ResearchActivity["kind"])
          ? (evt.activityKind as ResearchActivity["kind"])
          : "status";
        const round = typeof evt.round === "number"
          ? Math.max(1, Math.min(cur.depth.rounds, Math.round(evt.round)))
          : undefined;
        const sourceUrl = evt.sourceUrl ? canonicalizeSourceUrl(evt.sourceUrl) ?? undefined : undefined;
        const activity: ResearchActivity = {
          kind,
          message,
          subQuestion: evt.subQuestion,
          round,
          sourceUrl,
          sourceTitle: evt.sourceTitle,
          at: Date.now(),
        };
        // Maintain the structured run view: sub-question plan, current
        // sub-question, and per-source reading/done status.
        let subQuestions = cur.subQuestions;
        if (kind === "plan" && message) {
          subQuestions = message
            .split(/\r?\n|;\s*/)
            .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
            .filter(Boolean)
            .slice(0, cur.depth.subQuestions);
        }
        const currentSubQuestion =
          kind === "subquestion" && evt.subQuestion ? evt.subQuestion : cur.currentSubQuestion;
        const currentRound = kind === "round" && round ? round : cur.currentRound;
        let sources = cur.sources;
        if (sourceUrl) {
          const existing = sources.find((s) => s.url === sourceUrl);
          if (kind === "source") {
            sources = existing
              ? sources.map((s) => (s.url === sourceUrl ? { ...s, status: "reading", title: evt.sourceTitle ?? s.title } : s))
              : [...sources, { url: sourceUrl, title: evt.sourceTitle, status: "reading", observed: false }];
          } else if (kind === "note") {
            sources = existing
              ? sources.map((s) => (s.url === sourceUrl ? { ...s, status: "done", title: evt.sourceTitle ?? s.title } : s))
              : [...sources, { url: sourceUrl, title: evt.sourceTitle, status: "done", observed: false }];
          }
        }
        sources = sources.slice(0, cur.depth.maxSources);
        set({
          deepResearch: {
            ...cur,
            phase: phase === "planning" || phase === "synthesizing" ? phase : "researching",
            launchStage: "active",
            firstSignalAt: cur.firstSignalAt ?? Date.now(),
            piTurnEnded: undefined,
            activity: [...cur.activity, activity].slice(-300),
            subQuestions,
            currentSubQuestion,
            currentRound,
            sources,
            reportDraft:
              typeof evt.draftMarkdown === "string"
                ? truncateUtf8(evt.draftMarkdown, DEFAULT_DEEP_RESEARCH_LIMITS.maxReportBytes)
                : cur.reportDraft,
          },
        });
      } else if (evt.kind === "blocked") {
        void drStopListening();
        const reason = (evt.reason ?? evt.message ?? "Pi could not safely complete the research protocol.").slice(0, 2000);
        drPatch({
          phase: "error",
          launchStage: "error",
          error: `Deep Research blocked by Pi:\n${reason}\nNo vault changes were made. Copy the troubleshooting kit and rerun after correcting the tool, source, or evidence problem.`,
          activity: [
            ...(get().deepResearch?.activity ?? []),
            { kind: "status" as const, message: `Deep Research blocked: ${reason.replace(/\n/g, " ")}`, at: Date.now() },
          ].slice(-300),
        });
      } else if (evt.kind === "finish") {
        let reply: ResearchFinishReply;
        try {
          reply = await drFinish(runId, evt.result);
        } catch (error) {
          const message = `Mesa could not validate the finish payload: ${String(error)}`;
          void drStopListening();
          drPatch({ phase: "error", launchStage: "error", error: message });
          reply = { status: "stopped", message };
        }
        if (!evt.requestId) {
          void drStopListening();
          drPatch({ phase: "error", launchStage: "error", error: "Deep Research finish lacks a request ID." });
          return;
        }
        void researchRun.respondResearchFinish(runId, evt.requestId, reply).catch((error) => {
          if (get().deepResearch?.runId !== runId) return;
          drPatch({ error: `Could not return Mesa's validation decision to Pi: ${String(error)}` });
        });
      }
    });
    if (!current()) { unlisten(); return; }
    drUnlisten = unlisten;
    // Record observed browser navigation separately from model-reported progress. Subscription failure is nonfatal.
    drLastObservedUrl = null;
    const observeNavigation = (rawUrl: unknown) => {
      const cur = get().deepResearch;
      if (!cur || cur.runId !== runId) return;
      if (!researchRunIsCurrent(runId, cur.vaultRoot, cur.vaultGeneration)) return;
      if (cur.phase !== "planning" && cur.phase !== "researching" && cur.phase !== "synthesizing") return;
      const activity = activityForNavigation(String(rawUrl ?? ""), Date.now());
      if (!activity?.sourceUrl) return;
      // browse + harness-nav both fire for one navigation — collapse the echo.
      if (activity.sourceUrl === drLastObservedUrl) return;
      drLastObservedUrl = activity.sourceUrl;
      drLastEventAt = Date.now();
      let sources = cur.sources;
      if (activity.kind === "source") {
        const existingIndex = sources.findIndex((s) => s.url === activity.sourceUrl);
        if (existingIndex >= 0) {
          sources = sources.slice();
          sources[existingIndex] = {
            ...sources[existingIndex],
            title: activity.sourceTitle ?? sources[existingIndex].title,
            observed: true,
          };
        } else {
          sources = [...sources, { url: activity.sourceUrl, title: activity.sourceTitle, status: "reading" as const, observed: true }]
            .slice(0, cur.depth.maxSources);
        }
      }
      set({
        deepResearch: {
          ...cur,
          launchStage: "active",
          firstSignalAt: cur.firstSignalAt ?? Date.now(),
          activity: [...cur.activity, activity].slice(-300),
          sources,
        },
      });
    };
    if (IN_TAURI) {
      try {
        const browse = await listen<string>("mesa://browse", (ev) => observeNavigation(ev.payload));
        if (!current()) { browse(); return; }
        drNavUnlistens.push(browse);
        const harness = await listen<{ url?: string }>("mesa://harness-nav", (ev) => observeNavigation(ev.payload?.url));
        if (!current()) { harness(); return; }
        drNavUnlistens.push(harness);
      } catch {
        // Roll back partial observation; progress has its own subscription.
        if (!current()) return;
        for (const un of drNavUnlistens) { try { un(); } catch { /* already gone */ } }
        drNavUnlistens = [];
      }
    }
    if (!current()) return;
    drLastEventAt = Date.now();
    const armTimeout = (delay: number) => {
      drTimeout = setTimeout(() => {
        const cur = get().deepResearch;
        if (!cur || cur.runId !== runId) return;
        if (cur.phase === "review" || cur.phase === "done" || cur.phase === "error" || cur.phase === "cancelled") return;
        // Still hearing from the run (progress OR observed browsing)? Then it
        // is slow, not stuck — re-arm for the remainder of the quiet window.
        const idle = Date.now() - drLastEventAt;
        if (idle < DR_TIMEOUT_MS) {
          armTimeout(DR_TIMEOUT_MS - idle);
          return;
        }
        const sid = currentPiSessionId();
        // A live shared Pi session is not proof that the model has finished,
        // but it distinguishes slow provider processing from dead transport.
        // Keep the run alive so long prompt processing does not become a
        // false Deep Research failure. The panel's separate inactivity
        // watchdog still exposes the troubleshooting kit.
        if (sid) {
          armTimeout(DR_TIMEOUT_MS);
          return;
        }
        void drStopListening();
        drPatch({
          phase: "error",
          launchStage: "error",
          error: explainResearchTimeout({ run: cur, piSessionLive: Boolean(sid) }),
        });
        if (sid) void requestSharedPiRestart();
      }, delay);
    };
    armTimeout(DR_TIMEOUT_MS);
  }

  const actions: Pick<AppState, 'setDeepResearchSurface' | 'openDeepResearch' | 'startDeepResearch' | 'cancelDeepResearch' | 'applyDeepResearch' | 'discardDeepResearch'> = {
    setDeepResearchSurface: (surface) => {
      const previous = get().deepResearchSurface;
      if (previous === surface) return;
      // Moving the presentation back into Mesa also closes the detached
      // monitor. Otherwise the single shared run would be visible twice.
      if (IN_TAURI && previous?.startsWith("native:")) {
        const label = previous.slice("native:".length);
        void import("@tauri-apps/api/webviewWindow")
          .then(async ({ WebviewWindow }) => {
            const win = await WebviewWindow.getByLabel(label);
            await win?.close();
          })
          .catch(() => undefined);
      }
      set({ deepResearchSurface: surface });
    },

    openDeepResearch: (openOverlay = true, overlayRec) => {
      // Opening a surface never resets an in-flight run — it only ensures the
      // run object exists so both launchers read/drive the same state, then
      // optionally requests the Mesa overlay's Research window. Pi's launcher
      // passes false and owns its slide-out wing instead.
      const cur = get().deepResearch;
      if (!cur) {
        set({
          deepResearch: {
            runId: createRunId(),
            vaultRoot: get().vaultPath,
            vaultGeneration: getGeneration(),
            query: "",
            phase: "idle",
            launchStage: "idle",
            startedAt: 0,
            promptBytes: 0,
            promptSentAt: null,
            firstSignalAt: null,
            depth: clampDepth(
              RESEARCH_DEPTH_PRESETS[
              (get().settings.researchDepth as keyof typeof RESEARCH_DEPTH_PRESETS) in RESEARCH_DEPTH_PRESETS
                ? (get().settings.researchDepth as keyof typeof RESEARCH_DEPTH_PRESETS)
                : "standard"
              ]
            ),
            context: null,
            activity: [],
            subQuestions: [],
            currentRound: 0,
            currentSubQuestion: null,
            sources: [],
            reportDraft: "",
            result: null,
            changeSet: null,
            error: null,
            appliedRelPaths: [],
            seq: drSeq,
          },
        });
      }
      if (openOverlay) {
        get().setDeepResearchSurface("overlay");
        set({
          overlayOpen: true,
          piOverlayOpen: false,
          overlayWindowRequest: { id: "research", rec: overlayRec },
        });
      }
    },

    startDeepResearch: async (query, opts) => {
      const trimmed = query.trim();
      const root = get().vaultPath;
      if (!trimmed) {
        get().openDeepResearch(false);
        drPatch({ phase: "error", launchStage: "error", error: "Enter a research question first." });
        return;
      }
      if (!root) {
        get().openDeepResearch(false);
        drPatch({ phase: "error", launchStage: "error", error: "Open a vault before running Deep Research." });
        return;
      }
      // Never stack runs: a run already streaming must be cancelled first.
      const existing = get().deepResearch;
      if (existing && (existing.phase === "planning" || existing.phase === "researching" || existing.phase === "synthesizing")) {
        drPatch({ phase: existing.phase, launchStage: existing.launchStage, error: "A Deep Research run is already in progress — cancel it first." });
        return;
      }

      const depth = clampDepth(
        opts?.depth ??
        RESEARCH_DEPTH_PRESETS[
        (get().settings.researchDepth as keyof typeof RESEARCH_DEPTH_PRESETS) in RESEARCH_DEPTH_PRESETS
          ? (get().settings.researchDepth as keyof typeof RESEARCH_DEPTH_PRESETS)
          : "standard"
        ]
      );
      const limits = limitsForDepth(DEFAULT_DEEP_RESEARCH_LIMITS, depth);
      const scope: ResearchContextScope =
        (opts?.scope ?? get().settings.researchContextScope) === "vault" ? "vault" : "workspace";
      const runId = createRunId();
      const runGeneration = getGeneration();
      const launchIsCurrent = () => researchRunIsCurrent(runId, root, runGeneration)
        && ["planning", "researching", "synthesizing"].includes(get().deepResearch?.phase ?? "");
      drSeq += 1;
      drFinishRejectionCount = 0;
      drRepairPromptedAttempt = 0;
      set({
        deepResearch: {
          runId,
          vaultRoot: root,
          vaultGeneration: runGeneration,
          query: trimmed,
          phase: "planning",
          launchStage: "preparing",
          startedAt: Date.now(),
          promptBytes: 0,
          promptSentAt: null,
          firstSignalAt: null,
          depth,
          context: null,
          activity: [{ kind: "status", message: "Preparing research context…", at: Date.now() }],
          subQuestions: [],
          currentRound: 0,
          currentSubQuestion: null,
          sources: [],
          reportDraft: "",
          result: null,
          changeSet: null,
          error: null,
          appliedRelPaths: [],
          seq: drSeq,
        },
      });
      const contextHandle = backgroundWork.enqueue("research", async () => {
        const cur = get().deepResearch;
        if (
          cur?.phase === "cancelled" ||
          !researchRunIsCurrent(runId, root, runGeneration)
        ) {
          throw new BackgroundWorkCancelledError("Deep Research cancelled before context preparation.");
        }
        const research = await loadDeepResearch();
        return research.buildResearchContext({
          query: trimmed,
          activePath: get().activePath,
          selectedPaths: opts?.selectedPaths ?? [],
          files: get().files,
          notes: get().notes,
          content: get().contentCache,
          limits,
          scope,
        });
      });
      drContextHandle = contextHandle;
      let context: DeepResearchContext;
      try {
        context = await contextHandle.promise;
      } catch (error) {
        if (error instanceof BackgroundWorkCancelledError) return;
        if (researchRunIsCurrent(runId, root, runGeneration)) {
          drPatch({
            phase: "error",
            launchStage: "error",
            error: `Could not prepare research context: ${String(error)}`,
          });
        }
        return;
      } finally {
        if (drContextHandle === contextHandle) drContextHandle = null;
      }
      const afterContext = get().deepResearch;
      if (
        afterContext?.phase === "cancelled" ||
        !researchRunIsCurrent(runId, root, runGeneration)
      ) {
        return;
      }
      drPatch({ context });

      // The shared Pi session must be live AND running with the Deep Research
      // extension (its progress/finish tools + fail-safe write/edit block).
      // That extension loads at spawn time, so a session that started without
      // it must restart — one `terminal_stop`, then the normal path respawns
      // it. We never spawn a second Pi process.
      if (!IN_TAURI) {
        drPatch({
          phase: "error",
          launchStage: "error",
          error:
            "Deep Research needs the desktop app's Pi agent. The browser demo has no native Pi session.",
        });
        return;
      }
      // Mount a Pi surface only when the launcher is not already inside one.
      // This avoids opening a duplicate Pi modal behind the slide-out wing.
      if (!currentPiSessionId() && !opts?.piSurfaceAvailable) {
        drPatch({ launchStage: "starting-pi" });
        if (get().overlayOpen) {
          set({
            overlayOpen: true,
            overlayWindowRequest: { id: "agent" },
          });
        } else {
          set({ agentOpen: true });
        }
      } else if (!currentPiSessionId()) {
        drPatch({ launchStage: "starting-pi" });
      }
      if (currentPiSessionId()) {
        drPatch({ launchStage: "restarting-pi" });
        await requestSharedPiRestart();
      }
      let sessionId: string | null = null;
      const piStartupDeadline = Date.now() + DR_PI_STARTUP_WAIT_MS;
      while (!sessionId && Date.now() < piStartupDeadline) {
        await new Promise((r) => setTimeout(r, 150));
        sessionId = currentPiSessionId();
        if (!launchIsCurrent()) return; // superseded, cancelled, or vault changed
      }
      if (!sessionId) {
        drPatch({
          phase: "error",
          launchStage: "error",
          error:
            "Pi did not start in time. Open the Pi agent (Ctrl/Cmd+Shift+Space), let it finish starting, then run Deep Research again.",
        });
        if (currentPiSessionId()) await requestSharedPiRestart();
        return;
      }

      // Arm the result listener BEFORE sending the prompt so a fast model
      // can't finish before Mesa is listening.
      drPatch({ launchStage: "bridge-ready", piSessionId: sessionId });
      try {
        if (!launchIsCurrent()) return;
        await drStartListening(runId);
      } catch (e) {
        if (!launchIsCurrent()) return;
        drPatch({ phase: "error", launchStage: "error", error: `Could not start the Deep Research progress bridge: ${String(e)}` });
        if (currentPiSessionId()) await requestSharedPiRestart();
        return;
      }

      const researchModule = await loadDeepResearch();
      if (!launchIsCurrent()) return;
      const prompt = researchModule.buildResearchPrompt({
        runId,
        query: trimmed,
        context,
        folder: get().settings.researchFolder || "Research",
        depth,
      });
      drPatch({
        launchStage: "submitting",
        promptBytes: utf8ByteLength(prompt),
        activity: [
          ...(get().deepResearch?.activity ?? []),
          { kind: "status" as const, message: "Submitting the research task to Pi…", at: Date.now() },
        ].slice(-300),
      });
      try {
        const driver = await loadDeepResearchRun();
        if (!launchIsCurrent()) return;
        await driver.sendResearchPrompt(sessionId, prompt);
        if (!launchIsCurrent()) return;
        drPatch({
          phase: "researching",
          launchStage: "waiting-for-model",
          promptSentAt: Date.now(),
          activity: [
            ...(get().deepResearch?.activity ?? []),
            {
              kind: "status" as const,
              message: "Research task submitted to Pi; waiting for the first model or browser signal…",
              at: Date.now(),
            },
          ].slice(-300),
        });
      } catch (e) {
        if (!launchIsCurrent()) return;
        await drStopListening();
        drPatch({ phase: "error", launchStage: "error", error: `Could not submit the research task to Pi: ${String(e)}` });
        if (currentPiSessionId()) await requestSharedPiRestart();
      }
    },

    cancelDeepResearch: async () => {
      const cur = get().deepResearch;
      if (!cur) return;
      if (cur.phase === "applying") return;
      drContextHandle?.cancel(new BackgroundWorkCancelledError("Deep Research cancelled before context preparation."));
      drContextHandle = null;
      const sid = currentPiSessionId();
      // Revoke publication and subscriptions before awaiting native cancellation.
      const stopped = drStopListening();
      drPatch({ phase: "cancelled", launchStage: "cancelled", error: null, changeSet: null });
      await stopped;
      if (sid) {
        await (await loadDeepResearchRun()).interruptPi(sid);
        if (get().deepResearch?.runId === cur.runId) await requestSharedPiRestart();
      }
    },

    applyDeepResearch: async () => {
      const cur = get().deepResearch;
      if (!cur || !cur.changeSet) return;
      if (!researchRunIsCurrent(cur.runId, cur.vaultRoot, cur.vaultGeneration)) {
        drPatch({
          phase: "cancelled",
          launchStage: "cancelled",
          changeSet: null,
          error: "Deep Research is no longer attached to the active vault.",
        });
        return;
      }
      const root = cur.vaultRoot;
      if (!root) {
        drPatch({ phase: "error", launchStage: "error", error: "The vault is no longer open." });
        return;
      }
      const isCurrent = () =>
        researchRunIsCurrent(cur.runId, root, cur.vaultGeneration);
      // Version-check the change set against the CURRENT vault before writing.
      const plan = (await loadDeepResearchRun()).resolveApplyPlan({
        ops: cur.changeSet.ops,
        existingContent: get().contentCache,
        files: get().files,
        notes: get().notes,
      });
      if (!plan.ok) {
        drPatch({ phase: "error", launchStage: "error", error: plan.error, changeSet: null });
        return;
      }
      drPatch({ phase: "applying", launchStage: "applying" });
      const outcome = await (await loadDeepResearchRun()).applyChangeSet({ root, plan });
      if (!isCurrent()) return;
      if (!outcome.ok) {
        drPatch({ phase: "error", launchStage: "error", error: outcome.error ?? "Apply failed.", changeSet: null });
        return;
      }
      drPatch({ phase: "done", launchStage: "done", appliedRelPaths: outcome.appliedRelPaths });
      // Refresh the vault scan, content cache, backlinks, and graph so the new
      // notes and links appear (and the graph lights up) immediately.
      await refreshMissingExternalFiles(root, isCurrent);
      if (!isCurrent()) return;
      const latest = get();
      const notes = { ...latest.notes };
      const contentCache = forkContentCache(latest.contentCache);
      for (const op of cur.changeSet.ops) {
        contentCache[op.relPath] = op.content;
        const file = latest.fileFor(op.relPath);
        if (file?.isMarkdown) {
          const existing = notes[op.relPath];
          notes[op.relPath] = {
            relPath: op.relPath,
            title: existing?.title ?? file.name,
            rawLinks: extractLinks(op.content),
            tags: extractTags(op.content),
            aliases: extractAliases(op.content),
            firstImagePath: existing?.firstImagePath,
          };
        }
        bumpActivityAmount(op.relPath, 1.3, op.kind === "create" ? "create" : "write");
      }
      set({
        notes,
        contentCache,
        ...(latest.activePath && cur.changeSet.ops.some((op) => op.relPath === latest.activePath)
          ? { content: contentCache[latest.activePath] ?? latest.content }
          : {}),
      });
      // Surface the report note for the user.
      const reportRel = cur.changeSet.reportRelPath;
      if (isCurrent() && get().fileFor(reportRel)) await get().openFile(reportRel);
    },

    discardDeepResearch: () => {
      void drStopListening();
      set({ deepResearch: null, deepResearchSurface: null });
    },

  };
  return { actions, stop: drStopListening };
}
