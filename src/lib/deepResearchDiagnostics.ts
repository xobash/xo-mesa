import type {
  DeepResearchContext,
  DeepResearchPhase,
  DeepResearchLaunchStage,
  ResearchActivity,
  ResearchDepth,
} from "./deepResearch";
import { redactResearchContent, utf8ByteLength } from "./deepResearch";
import { formatLogTime } from "./syncDiagnostics";

/**
 * Deep Research troubleshooting kit — a single copy-pasteable markdown blob
 * built from the run's structured state, mirroring the sync console's
 * troubleshooting package. Written for exactly one audience: an LLM (or a
 * human) debugging a failed/stuck run, so it front-loads environment,
 * settings, the context that was sent, and the full activity timeline —
 * including which entries were OBSERVED by Mesa (real harness navigations)
 * versus self-reported by the model, which is the single most diagnostic
 * signal for "the model never engaged the protocol".
 *
 * SECRETS: every line is scrubbed with `redactResearchContent` (private-key
 * blocks, credential assignments, provider-token shapes). The vault's
 * absolute path is never accepted as input — note references are
 * vault-relative, and the model/provider settings never include the API key.
 */

/** The run-state slice the kit needs (a structural subset of the store's
 *  DeepResearchRunState, so the pure module never imports the store). */
export interface ResearchRunSnapshot {
  runId: string;
  phase: DeepResearchPhase;
  launchStage: DeepResearchLaunchStage;
  query: string;
  depth: ResearchDepth;
  startedAt: number;
  promptBytes: number;
  promptSentAt: number | null;
  firstSignalAt: number | null;
  error: string | null;
  context: DeepResearchContext | null;
  subQuestions: string[];
  currentRound: number;
  currentSubQuestion: string | null;
  sources: {
    url: string;
    title?: string;
    status: string;
    archiveStatus?: string;
    archiveRelPath?: string;
    archiveKind?: string;
    archiveError?: string;
  }[];
  activity: ResearchActivity[];
  reportDraft: string;
}

export interface ResearchDiagnosticsInput {
  /** App version (Tauri `getVersion()`), "dev" when unavailable. */
  appVersion: string;
  /** `navigator.userAgent` — identifies OS + webview. */
  userAgent: string;
  /** Vault stats (never the vault path). */
  vaultFileCount: number;
  vaultNoteCount: number;
  /** Whether the shared Pi session is currently live. */
  piSessionLive: boolean;
  /** Mesa-side agent config; the API key must never be passed in. */
  agentProvider: string;
  agentModel: string;
  run: ResearchRunSnapshot;
  /** Injectable clock for tests. */
  now?: Date;
}

export const RESEARCH_TROUBLESHOOTING_IDLE_MS = 120_000;
export type ResearchTroubleshootingTrigger = "confirmed-error" | "initial-inactivity";

/**
 * Keep diagnostics out of the healthy-run UI. They become available only
 * after a confirmed run error or when a submitted prompt produces zero real
 * actions for two minutes. Mesa's own seeded `status` lines do not count.
 */
export function researchTroubleshootingTrigger(
  run: ResearchRunSnapshot,
  now = Date.now()
): ResearchTroubleshootingTrigger | null {
  if (run.startedAt <= 0) return null;
  if (run.phase === "error" && Boolean(run.error)) return "confirmed-error";
  if (run.phase !== "planning" && run.phase !== "researching" && run.phase !== "synthesizing") {
    return null;
  }
  if (run.activity.some((activity) => activity.kind !== "status")) return null;
  if (!run.promptSentAt) return null;
  return now - run.promptSentAt >= RESEARCH_TROUBLESHOOTING_IDLE_MS
    ? "initial-inactivity"
    : null;
}

const ACTIVITY_LINES_MAX = 80;
const SOURCE_LINES_MAX = 40;
const CONTEXT_NOTES_MAX = 20;

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Model self-reports: progress-tool calls (anything Mesa didn't observe
 *  itself, excluding Mesa's own seeded status lines). */
function selfReported(activity: ResearchActivity[]): ResearchActivity[] {
  return activity.filter((a) => !a.observed && a.kind !== "status");
}

function observed(activity: ResearchActivity[]): ResearchActivity[] {
  return activity.filter((a) => a.observed);
}

/**
 * A specific, multi-line diagnosis for a run that timed out from inactivity.
 * Branches on the most diagnostic signals: is Pi alive, did the model ever
 * call the progress tool, and did Mesa observe any real browsing.
 */
export function explainResearchTimeout(input: {
  run: ResearchRunSnapshot;
  piSessionLive: boolean;
  now?: number;
}): string {
  const { run, piSessionLive } = input;
  const now = input.now ?? Date.now();
  const self = selfReported(run.activity);
  const seen = observed(run.activity);
  const lastAt = run.activity.reduce((m, a) => Math.max(m, a.at), run.startedAt);
  const lines: string[] = [
    `Deep Research timed out after ${minutes(now - run.startedAt)} — no activity for the last ${minutes(now - lastAt)}.`,
  ];
  if (!piSessionLive) {
    lines.push(
      "The Pi session is no longer running — it may have crashed or been closed. Reopen the Pi agent, let it finish starting, then run again."
    );
  } else if (self.length === 0 && seen.length === 0) {
    if (run.launchStage === "waiting-for-model" && run.promptSentAt) {
      lines.push(
        `Mesa submitted a ${run.promptBytes} B research prompt to Pi's PTY, but received NO model progress and observed NO web browsing. ` +
          "The prompt may not have been accepted by Pi, or the provider may not have started the model turn. Check the Pi terminal for the submitted prompt and the model server logs."
      );
    } else {
      lines.push(
        "Mesa received NO progress reports from the model and observed NO web browsing. " +
          "The model most likely never engaged the Deep Research protocol (the deep_research_progress / deep_research_finish tool calls) — " +
          "smaller local models often cannot follow it. Check the Pi terminal scrollback to see what the model actually did; " +
          "a stronger model, or the Quick preset, usually fixes this."
      );
    }
  } else if (self.length === 0) {
    lines.push(
      `Mesa observed ${seen.length} real page visit${seen.length === 1 ? "" : "s"} in the browser harness, but the model never called deep_research_progress — ` +
        "it browsed without following the structured protocol, so a finish envelope was never coming. " +
        "Check the Pi terminal scrollback; a stronger model usually fixes this."
    );
  } else {
    const doneSources = run.sources.filter((s) => s.status === "done").length;
    const last = self[self.length - 1];
    lines.push(
      `The run went quiet after "${last.message.slice(0, 120)}" — round ${Math.max(1, run.currentRound)}/${run.depth.rounds}, ` +
        `${doneSources}/${run.sources.length} sources read, ${utf8ByteLength(run.reportDraft)} B of report drafted. ` +
        "The provider may have stalled mid-run. Check the Pi terminal, then run again (a lighter preset finishes faster)."
    );
  }
  lines.push(
    "Use “Copy troubleshooting kit” to capture the full run timeline for a bug report or an LLM."
  );
  return lines.join("\n");
}

/** Build the copy-pasteable, secret-scrubbed markdown troubleshooting kit. */
export function buildResearchTroubleshootingKit(input: ResearchDiagnosticsInput): string {
  const now = input.now ?? new Date();
  const { run } = input;
  const lines: string[] = [];
  const push = (s: string) => lines.push(redactResearchContent(s).content);

  push("# Mesa Deep Research troubleshooting kit");
  push("");
  push(`- Generated: ${now.toISOString()}`);
  push(`- Mesa version: ${input.appVersion}`);
  push(`- Environment: ${input.userAgent}`);
  push(`- Vault: ${input.vaultFileCount} files / ${input.vaultNoteCount} notes (path withheld)`);
  push(`- Pi session live: ${input.piSessionLive ? "yes" : "no"}`);
  push(`- Agent config (Mesa-side): provider ${input.agentProvider || "manual"}, model ${input.agentModel || "(terminal-configured)"} (key never included)`);
  push("");

  push("## Run");
  push("");
  push(`- Run id: ${run.runId}`);
  push(`- Phase: ${run.phase}`);
  push(`- Launch stage: ${run.launchStage}`);
  push(`- Query: ${run.query || "(empty)"}`);
  push(
    `- Depth: ${run.depth.rounds} round${run.depth.rounds === 1 ? "" : "s"}, ${run.depth.subQuestions} sub-questions, ≤${run.depth.maxSources} sources, ≤${run.depth.maxGeneratedNotes} notes`
  );
  push(
    `- Started: ${run.startedAt ? new Date(run.startedAt).toISOString() : "(not started)"}${
      run.startedAt ? ` (${minutes(now.getTime() - run.startedAt)} ago)` : ""
    }`
  );
  push(`- Prompt: ${run.promptBytes} B${run.promptSentAt ? `, submitted to PTY at ${new Date(run.promptSentAt).toISOString()}` : ", not submitted to PTY"}`);
  push(`- First model/browser signal: ${run.firstSignalAt ? new Date(run.firstSignalAt).toISOString() : "none"}`);
  if (run.error) push(`- Error: ${run.error.replace(/\s*\n\s*/g, " ")}`);
  push("");

  push("## Context sent to Pi");
  push("");
  if (!run.context) {
    push("- (none — the run never built a context)");
  } else {
    push(`- Scope: ${run.context.scope}`);
    push(`- ${run.context.summary}`);
    const viaCounts = new Map<string, number>();
    for (const n of run.context.notes) {
      for (const v of n.via) viaCounts.set(v, (viaCounts.get(v) ?? 0) + 1);
    }
    if (viaCounts.size) {
      push(
        `- Selected via: ${[...viaCounts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`
      );
    }
    for (const n of run.context.notes.slice(0, CONTEXT_NOTES_MAX)) {
      push(`  - ${n.relPath} (${n.via.join(", ")}${n.redacted ? ", redacted" : ""})`);
    }
    if (run.context.notes.length > CONTEXT_NOTES_MAX) {
      push(`  - …and ${run.context.notes.length - CONTEXT_NOTES_MAX} more`);
    }
  }
  push("");

  push("## Progress");
  push("");
  const self = selfReported(run.activity);
  const seen = observed(run.activity);
  push(
    `- Model self-reports (deep_research_progress): ${self.length} · Mesa-observed navigations: ${seen.length}`
  );
  push(
    `- Sub-questions announced: ${run.subQuestions.length}${run.currentSubQuestion ? ` (current: ${run.currentSubQuestion})` : ""}`
  );
  push(`- Round: ${run.currentRound}/${run.depth.rounds}`);
  const doneSources = run.sources.filter((s) => s.status === "done").length;
  push(`- Sources: ${doneSources} read / ${run.sources.length} opened`);
  push(`- Report draft: ${utf8ByteLength(run.reportDraft)} B`);
  if (run.sources.length) {
    push("");
    push("### Sources");
    push("");
    for (const s of run.sources.slice(0, SOURCE_LINES_MAX)) {
      const archive = s.archiveStatus
        ? ` · archive=${s.archiveStatus}${s.archiveKind ? `:${s.archiveKind}` : ""}${
            s.archiveRelPath ? ` (${s.archiveRelPath})` : ""
          }${s.archiveError ? ` error=${s.archiveError}` : ""}`
        : "";
      push(`- [${s.status}] ${s.title ? `${s.title} — ` : ""}${s.url}${archive}`);
    }
    if (run.sources.length > SOURCE_LINES_MAX) {
      push(`- …and ${run.sources.length - SOURCE_LINES_MAX} more`);
    }
  }
  push("");

  push("## Activity timeline");
  push("");
  if (run.activity.length === 0) {
    push("- (no activity was recorded)");
  } else {
    const tail = run.activity.slice(-ACTIVITY_LINES_MAX);
    if (run.activity.length > tail.length) {
      push(`- (${run.activity.length - tail.length} earlier entries omitted)`);
    }
    for (const a of tail) {
      const tags = [a.kind, a.observed ? "observed" : "self-reported"];
      const extra = a.round ? ` (round ${a.round})` : "";
      push(`- ${formatLogTime(a.at)} [${tags.join(", ")}] ${a.message}${extra}`);
    }
  }
  push("");
  return lines.join("\n");
}
