import { forkContentCache, compactDocument } from "./lib/documentWorkingSet";
import { loadIndexedNotes, forgetVaultIndex, fingerprintText } from "./lib/vaultIndex";
import {
  BackgroundWorkCancelledError,
  backgroundWork,
  type BackgroundWorkHandle,
} from "./lib/backgroundWorkGovernor";
import {
  listTextRevisions,
  recordTextRevision,
  type TextRevision,
} from "./lib/textRevisionHistory";
import { readReviewText } from "./lib/vault";
import { conflictBackupPath, reviewedConflictPath } from "./lib/syncConflicts";
import { createSyncWorkflow } from "./lib/syncWorkflow";
import { create } from "zustand";
import type {
  VaultFile,
  NoteMeta,
  RightPanel,
  Settings,
  SyncPeer,
  PreviewTarget,
  PaneView,
  SortMode,
} from "./types";
import {
  placeInCenter,
  openViewInWorkspace,
  type PaneDrag,
} from "./lib/panes";
import {
  pickVault,
  assertVaultRootAvailable,
  scanVault,
  readNote,
  readNoteResult,
  readVaultText,
  readVaultTextOptional,
  VAULT_TEXT_CHUNK,
  vaultTextChunkConcurrency,
  peekNote,
  writeNote,
  createNote,
  createFolder,
  copyVaultFile,
  removeFile,
  removeVaultEntry,
  watchVault,
  importDroppedPaths,
  recoverWriteArtifacts,
  type FoundArtifact,
  isTextualVaultFile,
  resolveTextVaultLink,
  isIndexableVaultRelPath,
  flushableNoteText,
  needsCachedTextRefresh,
  extOf,
  stripExt,
  normalizeVaultRelPath,
  canonicalRoot,
  DEMO_ROOT,
  IN_TAURI,
  writeVaultTextFile,
  writeVaultBinaryFile,
  renameVaultFile,
  restoreRecoveryEntry,
  type RecoveryEntry,
  type VaultWatchEvent,
} from "./lib/vault";
import { hydrateVaultMetadata } from "./lib/vaultMetadata";
import { refreshedNoteMeta, resolveTarget } from "./lib/graph";
import { childRelPath, duplicateRelPath, ancestorFolders, safeBaseName } from "./lib/fsnames";
import { extractLinks, extractTags, extractAliases } from "./lib/markdownExtract";
import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet,
  type ActivityOp,
} from "./lib/activity";
import {
  type SyncLogEntry,
  type SyncProgress,
  type SyncReport,
} from "./lib/sync";
import { normalizeSyncPort, parsePeerInput } from "./lib/pairing";
import { loadSettings, persistSettings } from "./lib/settings";
import type { KeyboardFocus } from "./lib/keyboardNav";
import {
  applyTemplate,
  localTime,
  localISO,
  parseEvents,
  serializeEvents,
  type CalEvent,
} from "./lib/daily";

const WIKI_LINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*?)\]\(([^)\s]+?)\)/g;

function rewriteInboundLinks(
  sourceRel: string,
  content: string,
  oldRel: string,
  newRel: string,
  notes: Record<string, NoteMeta>
): { text: string; changed: boolean } {
  const sourceDir = sourceRel.includes("/") ? sourceRel.slice(0, sourceRel.lastIndexOf("/")) : "";
  const resolve = (target: string) =>
    resolveTarget(notes, target) === oldRel ||
    resolveTarget(notes, normalizeRelativeTarget(sourceDir, target)) === oldRel;
  const replacementTarget = (rawTarget: string): string => {
    const slashy = rawTarget.replace(/\\/g, "/");
    const hadExt = /\.(md|markdown)$/i.test(slashy.split("#")[0] ?? "");
    const hadDir = slashy.includes("/");
    const nextRel =
      hadDir && !slashy.startsWith("/")
        ? relativeTargetFrom(sourceDir, newRel)
        : newRel;
    if (hadDir) return hadExt ? nextRel : stripExt(nextRel);
    const base = nextRel.slice(nextRel.lastIndexOf("/") + 1);
    return hadExt ? base : stripExt(base);
  };
  let changed = false;
  const text = content
    .replace(WIKI_LINK_RE, (match, bang: string, body: string) => {
      if (bang) return match;
      const pipe = body.indexOf("|");
      const targetAndHeading = pipe >= 0 ? body.slice(0, pipe) : body;
      const alias = pipe >= 0 ? body.slice(pipe) : "";
      const hash = targetAndHeading.indexOf("#");
      const target = (hash >= 0 ? targetAndHeading.slice(0, hash) : targetAndHeading).trim();
      const heading = hash >= 0 ? targetAndHeading.slice(hash) : "";
      if (!target || !resolve(target)) return match;
      changed = true;
      return `[[${replacementTarget(target)}${heading}${alias}]]`;
    })
    .replace(MARKDOWN_LINK_RE, (match, bang: string, label: string, raw: string) => {
      if (bang || /^(https?:|mailto:|tel:|data:|#)/i.test(raw)) return match;
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        /* keep raw */
      }
      const hash = decoded.indexOf("#");
      const target = (hash >= 0 ? decoded.slice(0, hash) : decoded).trim();
      const heading = hash >= 0 ? decoded.slice(hash) : "";
      if (!target || !/\.(md|markdown)$/i.test(target) || !resolve(target)) return match;
      changed = true;
      const nextTarget = replacementTarget(target) + heading;
      const encoded = nextTarget.replace(/ /g, "%20");
      return `[${label}](${encoded})`;
    });
  return { text, changed };
}

function normalizeRelativeTarget(sourceDir: string, target: string): string {
  const slashy = target.replace(/\\/g, "/");
  if (!slashy.startsWith("./") && !slashy.startsWith("../")) return slashy;
  const parts = [...(sourceDir ? sourceDir.split("/") : []), ...slashy.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function relativeTargetFrom(sourceDir: string, targetRel: string): string {
  const from = sourceDir ? sourceDir.split("/") : [];
  const to = targetRel.split("/");
  const file = to.pop() ?? "";
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  const ups = from.slice(shared).map(() => "..");
  const downs = to.slice(shared);
  const rel = [...ups, ...downs, file].join("/");
  return rel || file;
}
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile as readTextFileStrict, stat } from "@tauri-apps/plugin-fs";
import { invalidatePdfThumb } from "./lib/pdfThumbInvalidation";
import { forgetRecentVault, rememberRecentVault } from "./lib/recentVaults";
import {
  planTextCache,
  retainLazyTextCache,
} from "./lib/textCachePlan";
import {
  STARTUP_TEXT_READ_CONCURRENCY,
} from "./lib/startupTextCache";
import { markMesaPerf } from "./lib/mesaPerf";
import { createSyncEventBridge } from "./lib/syncEventBridge";
import {
  SEARCH_CORPUS_BATCH,
  TEXT_CACHE_BUDGET_CHARS,
  mergeAbsentText,
  selectTextWithinBudget,
  streamTextBatches,
} from "./lib/searchCorpus";
import { createTextInterner, type TextInterner } from "./lib/textInterner";
import { forEachConcurrent } from "./lib/concurrency";
import { isDeepResearchBindingCurrent } from "./lib/deepResearchBinding";
import { resetSearchEligibility } from "./lib/searchMatch";
import {
  resetVaultTaskMemo,
  updateTaskLine,
  type TaskLinePatch,
} from "./lib/tasks";
import {
  AGENT_CONTEXT_EVENT,
  AGENT_WINDOW_READY_EVENT,
  getPiSessionSnapshot,
  requestSharedPiRestart,
} from "./lib/piSessionBridge";
import { buildAgentContext } from "./lib/agent";
import type { DetachedWindowPlacement } from "./lib/windowTearOff";
import { MESA_WINDOW_CHROME } from "./lib/windowChrome";
import {
  discardGraphWindowBootstrap,
  saveGraphWindowBootstrap,
} from "./lib/graphWindowBootstrap";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  clampDepth,
  limitsForDepth,
  truncateUtf8,
  utf8ByteLength,
} from "./lib/deepResearchConfig";
import { canonicalizeSourceUrl, activityForNavigation } from "./lib/deepResearchUrls";
import type {
  DeepResearchPhase,
  DeepResearchLaunchStage,
  DeepResearchResult,
  DeepResearchContext,
  ResearchChangeSet,
  ResearchContextScope,
  ResearchDepth,
  ResearchActivity,
} from "./lib/deepResearch";
const loadDeepResearch = () => import("./lib/deepResearch");
const createRunId = () => `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const currentPiSessionId = () => getPiSessionSnapshot().sessionId;
import type { ResearchFinishReply } from "./lib/deepResearchRun";
const loadDeepResearchRun = () => import("./lib/deepResearchRun");
import { explainResearchTimeout } from "./lib/deepResearchTimeout";
import {
  archiveWebPage,
  queueAcceptedResearchSources,
  researchArchiveRelPaths,
  type ArchiveFetchedPage,
} from "./lib/webArchive";
import {
  TextSaveCoordinator,
  type TextSaveHold,
} from "./lib/textSaveCoordinator";
import { createSaveIssueHelpers } from "./lib/saveIssues";
import { createFileIndex } from "./lib/fileIndex";
import { createWorkspaceActions } from "./lib/workspaceActions";
import {
  LAST_VAULT_KEY,
  THEME_KEY,
  RECENTS_KEY,
  MAX_RECENTS,
  initialRecents,
  initialTheme,
  migrateLegacyKeys,
  type ThemeId,
} from "./lib/persistedUi";
export type { ThemeId } from "./lib/persistedUi";

const CALENDAR_FILE = "calendar.json";


async function reclaimMainPiResizeOwnership(): Promise<void> {
  const session = getPiSessionSnapshot();
  if (!session.sessionId) return;
  try {
    await invoke("terminal_attach", {
      sessionId: session.sessionId,
      cols: session.cols,
      rows: session.rows,
    });
  } catch {
    // Best effort: the fallback AgentSurface will claim on focus/mount too.
  }
}
interface DragGhost {
  kind: "view" | "file";
  label: string;
  x: number;
  y: number;
}

export interface TextSaveIssue {
  /** Canonical absolute path used only as the save coordinator identity. */
  key: string;
  /** Vault-relative path safe to show in the UI. */
  relPath: string;
  message: string;
  busy: "retry" | "disk" | null;
}

/** The live state of one Deep Research run. Both Deep Research surfaces read
 *  and drive this single object; only one run exists at a time. */
export interface DeepResearchRunState {
  runId: string;
  /** Vault identity captured when this run was created. */
  vaultRoot: string | null;
  /** Reopen generation captured with `vaultRoot`; a path alone is not enough. */
  vaultGeneration: number;
  query: string;
  phase: DeepResearchPhase;
  /** Exact launch boundary, so a stuck run is diagnosable before timeout. */
  launchStage: DeepResearchLaunchStage;
  /** When the run was started (ms epoch), 0 while idle. Drives the
   *  inactivity timeout and the troubleshooting kit's elapsed times. */
  startedAt: number;
  /** UTF-8 size of the prompt Mesa attempted to submit to Pi. */
  promptBytes: number;
  /** When the prompt body + explicit Enter were accepted by the PTY bridge. */
  promptSentAt: number | null;
  /** First progress or real browser navigation observed for this run. */
  firstSignalAt: number | null;
  /** Shared PTY used by this run; detached diagnostics can snapshot it too. */
  piSessionId?: string;
  /** The thoroughness the run was started with. */
  depth: ResearchDepth;
  /** The deterministic context snapshot the run was started with. */
  context: DeepResearchContext | null;
  /** Live activity feed (newest last) — what the agent is doing, visible to the user. */
  activity: ResearchActivity[];
  /** Sub-questions announced by the plan (or in the final result). */
  subQuestions: string[];
  /** One-based live research round, or 0 before the first round starts. */
  currentRound: number;
  /** The sub-question currently being researched. */
  currentSubQuestion: string | null;
  /** Sources seen so far. Only final validated sources receive archive state. */
  sources: {
    url: string;
    title?: string;
    status: "reading" | "done";
    /** True only when Mesa observed the research browser navigate to this URL. */
    observed?: boolean;
    archiveStatus?: "saving" | "saved" | "failed";
    archiveRelPath?: string;
    archiveKind?: "page" | "link";
    archiveError?: string;
  }[];
  /** Latest report snapshot sent while Pi is assembling the deliverable. */
  reportDraft: string;
  /** Retained independently of the bounded activity tail. */
  finishRejection?: { attempt: number; reason: string; at: number; reportMarkdown?: string };
  /** Actual Pi loop end, not inferred from a quiet but live PTY. */
  piTurnEnded?: { reason: string; at: number };
  /** The validated, normalized result once the model finishes. */
  result: DeepResearchResult | null;
  /** The deterministic change set built from the result (review phase). */
  changeSet: ResearchChangeSet | null;
  /** A clear, actionable error for the error phase. */
  error: string | null;
  /** RelPaths written by a successful apply (for the done phase + refresh). */
  appliedRelPaths: string[];
  /** Monotonic id so a stale event from a previous run is ignored. */
  seq: number;
}

migrateLegacyKeys();

export const THEMES: { id: ThemeId; label: string; blurb: string }[] = [
  { id: "system", label: "System", blurb: "Neutral, follows OS light/dark" },
  { id: "void", label: "Void", blurb: "Violet pulse on black" },
  { id: "darkroom", label: "Darkroom", blurb: "Cinematic monochrome" },
];

/** Sidebar sort modes whose order depends on `size`/`mtime`, so vault open has
 *  to wait for the per-file stat pass instead of deferring it. */
const SORT_MODES_NEEDING_METADATA = new Set<SortMode>(["modified", "size"]);

/**
 * Stream the search-only text into the content cache after vault open, in
 * batches, while the app is already usable (see `lib/searchCorpus.ts` for why
 * this is not on the critical path).
 *
 * Three rules keep it safe to run behind a live UI:
 *   - every commit merges ABSENT keys only, so an edit, a watcher refresh or a
 *     lazy `ensureContent` read made while this runs always wins;
 *   - a per-file read failure skips that file instead of aborting — vault open
 *     no longer depends on every textual file being readable;
 *   - `vaultPath` is re-checked before each read and each commit, so switching
 *     vaults mid-hydration cannot pour the old vault's text into the new one.
 *
 * It also owns the memory ceiling. The budget used to be applied to the scan's
 * `size` metadata before any read, but that metadata is no longer available on
 * the open path (`loadVaultMetadata` runs after the first paint), so it is
 * applied here to real characters instead — a truer measure of what a JS string
 * costs. Whatever the ceiling leaves out is counted into `unindexedTextFiles`,
 * which the search UI states out loud.
 */
async function hydrateSearchCorpus(
  root: string,
  extra: readonly VaultFile[],
  interner: TextInterner,
  isCurrentOpen: () => boolean,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void
): Promise<void> {
  if (!extra.length) {
    interner.clear();
    if (isCurrentOpen()) markMesaPerf("search-index-ready", { files: 0 });
    return;
  }
  let cached = 0;
  let attempted = 0;
  let chars = 0;
  let budgetSkipped = 0;
  let overBudget = false;
  const stopped = () =>
    overBudget || !isCurrentOpen() || get().vaultPath !== root;

  await streamTextBatches(
    extra,
    (file) => file.relPath,
    async (file) => interner.intern(await readNote(file)),
    {
      concurrency: STARTUP_TEXT_READ_CONCURRENCY,
      batchSize: SEARCH_CORPUS_BATCH,
      // One round-trip per chunk. This half of the hydration runs while the
      // user is already typing, and on Windows every invoke response is
      // marshalled through the UI thread's message pump — so the round-trip
      // count here is input latency, not just background work.
      readChunk: async (group) =>
        (await readVaultTextOptional(root, group)).map((text) =>
          text == null ? null : interner.intern(text)
        ),
      chunkSize: VAULT_TEXT_CHUNK,
      chunkConcurrency: vaultTextChunkConcurrency(root),
      stopped,
      onError: (file, error) => {
        console.warn(
          "[mesa] search index skipped an unreadable file:",
          file.relPath,
          error
        );
      },
      commit: (done) => {
        if (!isCurrentOpen() || get().vaultPath !== root) return;
        attempted += done.size;
        const selected = selectTextWithinBudget(
          done,
          chars,
          TEXT_CACHE_BUDGET_CHARS
        );
        chars = selected.usedChars;
        budgetSkipped += selected.skipped;
        cached += selected.accepted.size;
        if (chars >= TEXT_CACHE_BUDGET_CHARS) overBudget = true;
        const cache = get().contentCache;
        const next = mergeAbsentText(cache, selected.accepted);
        const count = { indexingTextFiles: Math.max(0, extra.length - attempted) };
        set(next === cache ? count : { ...count, contentCache: next });
      },
    }
  );
  // The interner exists only to collapse duplicates WHILE the vault loads;
  // holding its buckets afterwards would pin every distinct document a second
  // time through the map, including any the budget dropped.
  if (interner.shared) {
    console.info(
      `[mesa] content cache: ${interner.shared} files reused an identical copy` +
        ` (${interner.sharedChars.toLocaleString()} characters not duplicated)`
    );
  }
  interner.clear();
  if (!isCurrentOpen() || get().vaultPath !== root) return;
  // Anything the ceiling (or an unreadable file) left out matches by name only
  // from here on, and must be reported rather than silently missing.
  set({
    indexingTextFiles: 0,
    unindexedTextFiles:
      get().unindexedTextFiles +
      budgetSkipped +
      Math.max(0, extra.length - attempted),
  });
  markMesaPerf("search-index-ready", { files: extra.length, cached, skipped: budgetSkipped });
}

export interface VaultUnavailableState {
  root: string;
  name: string;
  reason: string;
}

export interface AppState {
  vaultPath: string | null;
  vaultName: string;
  /** Remembered network/removable vault that is selected but not currently
   * reachable. It is not a valid empty workspace; App retries it in place. */
  unavailableVault: VaultUnavailableState | null;
  recentVaults: string[];
  calendarEvents: CalEvent[];
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
  contentCache: Record<string, string>;
  openTabs: string[];
  activePath: string | null;
  content: string;
  graphFull: boolean;
  loading: boolean;
  status: string;
  /** Every dirty text path whose verified write failed. */
  textSaveIssues: Record<string, TextSaveIssue>;
  textSaveState: import("./lib/textSaveCoordinator").TextSaveState;
  theme: ThemeId;
  settings: Settings;
  settingsIssue: string;
  retrySettings: () => void;
  saveConflictReview: (root: string, rel: string, expected: string, content: string, copyRel?: string) => Promise<string>;

  // transient UI
  /** Bumped to trigger a one-shot "reveal active file" in the file tree. */
  revealTick: number;
  paletteOpen: boolean;
  searchOpen: boolean;
  searchSeed: string;
  settingsOpen: boolean;
  diagnosticsOpen: boolean;
  popoutDoc: string | null;
  syncOpen: boolean;
  syncListening: boolean;
  syncBusy: boolean;
  syncStatus: string;
  syncPhase: import("./lib/sync").SyncPhase;
  /** Structured lines from the Rust sync engine — the embedded sync console.
   *  Capped at the most recent 1000 entries. */
  syncLog: SyncLogEntry[];
  /** Live engine progress while a sync runs (null when idle). */
  syncProgress: SyncProgress | null;
  /** Full report of the most recent completed sync attempt. */
  syncReport: SyncReport | null;
  /** Peer id of the most recent sync attempt (for the troubleshooting package). */
  syncLastPeerId: string | null;
  tasksOpen: boolean;
  helpOpen: boolean;
  tourOpen: boolean;
  overlayOpen: boolean;
  piOverlayOpen: boolean;
  agentOpen: boolean;
  /** Latest browse request from the embedded Pi agent's `browse` tool. The
   *  mounted Pi surface opens its harness wing and navigates here, so the
   *  user monitors the agent's browsing live. `seq` bumps per request so the
   *  same URL twice still re-navigates. */
  piBrowse: { url: string; seq: number } | null;
  /** The single active Deep Research run (null when idle). Shared by every
   *  Deep Research surface — the Steam-overlay window and the Pi panel button
   *  both read and drive this one run, never separate state machines. */
  deepResearch: DeepResearchRunState | null;
  /** The one visible Deep Research host. Pi surfaces claim this with a stable
   *  per-mount id; overlay/native hosts use a named id. Run state is shared,
   *  presentation ownership is exclusive. */
  deepResearchSurface: string | null;
  /** Tell the Steam overlay to open/focus a specific floating window, with
   *  optional geometry captured from another surface that is detaching into
   *  the overlay. */
  overlayWindowRequest: {
    id: "search" | "agent" | "research";
    rec?: { x: number; y: number; w: number; h: number };
  } | null;
  /** Floating preview card shown on sidebar / tag hover (graph manages its own). */
  hoverPreview: { target: PreviewTarget; x: number; y: number } | null;
  /** A view (panel or the editor) being dragged between regions / from a handle. */
  dragView: PaneDrag | null;
  /** A file being dragged from the sidebar (drives center/right drop hints). */
  draggingFile: string | null;
  /** Smooth pointer-following label for pane/file drags. */
  dragGhost: DragGhost | null;
  /** Region targeted by Vim-style keyboard navigation. */
  keyboardFocus: KeyboardFocus;
  /** Collapsed folder paths in the sidebar tree (true = collapsed). */
  collapsedFolders: Record<string, boolean>;
  /** Folders created this session that are still empty (not yet on disk scans),
   *  so the sidebar shows them immediately after "New folder". */
  emptyFolders: string[];
  /** Textual files whose content the vault-open text budget left uncached, so
   *  full-text search can only match them by name. Zero for every vault that
   *  fits the budget; surfaced in the search UI so incomplete results are
   *  never silent. */
  unindexedTextFiles: number;
  /** Textual files whose content is still streaming in after vault open. Only
   *  markdown is read before the UI exists (`buildNotes` needs all of it); the
   *  search-only remainder — 70% of the reads on the measured vault — hydrates
   *  in the background. Non-zero only during that window, and surfaced in the
   *  search UI so partial coverage is never silent. See `lib/searchCorpus.ts`. */
  indexingTextFiles: number;

  setTheme: (t: ThemeId) => void;
  setDragView: (d: PaneDrag | null) => void;
  setDraggingFile: (rel: string | null) => void;
  setDragGhost: (ghost: DragGhost | null) => void;
  setKeyboardFocus: (focus: KeyboardFocus) => void;
  toggleFolder: (path: string) => void;
  setCollapsedFolders: (map: Record<string, boolean>) => void;
  showHoverPreview: (target: PreviewTarget, x: number, y: number) => void;
  hideHoverPreview: () => void;
  setTasksOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setTourOpen: (open: boolean) => void;
  setOverlayOpen: (open: boolean) => void;
  toggleOverlay: () => void;
  setPiOverlayOpen: (open: boolean) => void;
  setAgentOpen: (open: boolean) => void;
  setDeepResearchSurface: (surface: string | null) => void;
  /** Open/refresh the shared Deep Research surface state. Both launchers (the
   *  Steam-overlay dock and the Pi panel button) call this one opener so they
   *  always drive the same active run. */
  openDeepResearch: (
    openOverlay?: boolean,
    overlayRec?: { x: number; y: number; w: number; h: number }
  ) => void;
  startDeepResearch: (
    query: string,
    opts?: {
      selectedPaths?: string[];
      depth?: ResearchDepth;
      scope?: ResearchContextScope;
      piSurfaceAvailable?: boolean;
    }
  ) => Promise<void>;
  cancelDeepResearch: () => Promise<void>;
  applyDeepResearch: () => Promise<void>;
  discardDeepResearch: () => void;
  openDailyNote: (dateISO: string) => Promise<void>;
  addCalendarEvent: (date: string, title: string) => Promise<void>;
  removeCalendarEvent: (date: string, title: string) => Promise<void>;
  addPersonalTask: (text: string) => Promise<void>;
  updateTask: (relPath: string, line: number, patch: TaskLinePatch) => Promise<void>;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  setPalette: (open: boolean) => void;
  openSearch: (seed?: string) => void;
  setSearch: (open: boolean) => void;
  setSearchSeed: (s: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setDiagnosticsOpen: (open: boolean) => void;
  setPopoutDoc: (rel: string | null) => void;
  setSyncOpen: (open: boolean) => void;
  /** Reveal the active file in the sidebar once (expand + scroll into view). */
  revealActiveFile: () => void;
  toggleListen: () => Promise<void>;
  syncNow: (peerId: string) => Promise<void>;
  syncAll: () => Promise<void>;
  cancelCurrentSync: () => Promise<void>;
  /** Wipe the sync console (log, progress, last report). */
  clearSyncLog: () => void;
  addPeer: (input: string, name?: string, fingerprint?: string) => string | null;
  updatePeer: (id: string, patch: Partial<SyncPeer>) => void;
  removePeer: (id: string) => void;
  /**
   * Clone a vault shared by another device into a folder the user picks, then
   * open it and remember the device for future two-way sync. Returns the pull
   * counts, or null if the user cancelled the folder picker. Throws on error.
   */
  receiveSharedVault: (opts: {
    address: string;
    token: string;
    name?: string;
    /** Certificate fingerprint observed while probing, pinned for future syncs. */
    fingerprint?: string;
  }) => Promise<{
    pulled: number;
    pushed: number;
    conflicts: number;
    fingerprint: string;
  } | null>;
  openDocWindow: (relPath: string) => Promise<void>;
  /** Returns true only after the detached window has adopted the live PTY. */
  openAgentWindow: (placement?: DetachedWindowPlacement) => Promise<boolean>;
  /** Open the shared Deep Research view in a separate Mesa native window. */
  openResearchWindow: (placement?: DetachedWindowPlacement) => Promise<boolean>;
  openVault: (path?: string) => Promise<void>;
  removeRecentVault: (path: string) => void;
  selectFile: (relPath: string) => Promise<void>;
  openFile: (relPath: string) => Promise<void>;
  openTarget: (target: string) => Promise<void>;
  setContentFromEditor: (text: string) => void;
  flushSave: () => Promise<void>;
  retryTextSaveIssue: (key: string) => Promise<void>;
  useDiskTextForSaveIssue: (key: string) => Promise<void>;
  listActiveTextRevisions: () => TextRevision[];
  restoreTextRevision: (revisionId: string) => Promise<void>;
  restoreRecoveryEntry: (entry: RecoveryEntry) => Promise<VaultFile>;
  newNote: () => Promise<void>;
  createChildNote: (folderPath: string) => Promise<void>;
  /** Save an overlay scratch item as a new, verified vault file. */
  saveOverlayArtifact: (
    kind: "scratchpad" | "whiteboard",
    content: string | Uint8Array,
    date?: string
  ) => Promise<string | null>;
  createChildFolder: (folderPath: string) => Promise<void>;
  duplicateEntry: (relPath: string) => Promise<void>;
  toggleBookmark: (relPath: string) => void;
  importDropped: (paths: string[]) => Promise<void>;
  deleteEntry: (relPath: string) => Promise<void>;
  renameNote: (relPath: string, newBaseName: string) => Promise<void>;
  closeTab: (relPath: string) => void;
  togglePanel: (panel: RightPanel) => void;
  removeViewFromWorkspace: (view: PaneView) => void;
  dropViewInCenter: () => void;
  dropViewAt: (index: number) => void;
  closeCenter: () => void;
  moveViewToCenter: (view: PaneView) => void;
  moveViewToRight: (view: PaneView, index?: number) => void;
  flipDockSide: () => void;
  openPanelWindow: (panel: RightPanel, placement?: DetachedWindowPlacement) => Promise<void>;
  toggleGraphFull: () => void;
  ensureContent: (relPath: string) => Promise<string>;
  /** Fast preview read: full cached content when available, otherwise a
   *  byte-capped head-of-file peek. Never populates the full content cache,
   *  so a truncated peek can never leak into an editor or a disk write. */
  ensurePeek: (relPath: string) => Promise<string>;
  fileFor: (relPath: string) => VaultFile | undefined;
}

export const useAppStore = create<AppState>((set, get) => {
  // Vault mutations that fail have to SAY so. Every one of these actions is
  // something the user explicitly asked for — often after confirming a
  // destructive dialog — and each one does its filesystem work BEFORE touching
  // the store, so a rejection leaves the vault and the UI correctly unchanged
  // but completely unexplained: the click looks ignored and the user retries.
  // Failure is not exotic on a real machine, and least so on Windows, where a
  // document open in another app, a OneDrive-synced folder, or an antivirus
  // scan holds a lock that makes remove/rename/copy throw where the same call
  // succeeds on macOS.
  //
  // `renameNote` and both save paths already report this way; this is the same
  // rule for the rest, so `status` (rendered by StatusBar in the danger color
  // with role="alert") stays the one place a failed vault write is announced.
  const { reportingFailure, recordTextSaveIssue, clearTextSaveIssues, setTextSaveIssueBusy } = createSaveIssueHelpers({ get, set });

  // Unsaved editor text belongs to a filesystem path, not to whichever tab is
  // active when a shared timer fires. The coordinator keeps one dirty record
  // per absolute path, serializes writes, and carries the exact disk baseline
  // into verifiedWrite's optimistic-concurrency check.
  const textSaves = new TextSaveCoordinator<VaultFile>({
    delayMs: 500,
    onStateChange: (textSaveState) => set({ textSaveState }),
    write: async ({ key, target, content, expectedContent }) => {
      const file = get().fileFor(target.relPath);
      if (!file || file.path !== key) {
        throw new Error(
          `Save target changed before ${target.relPath} could be written.`
        );
      }
      const pending = flushableNoteText(file, content);
      if (pending === null) {
        throw new Error(`Refusing to save non-text file ${target.relPath}.`);
      }
      await writeNote(file, pending, expectedContent);
      if (pending !== expectedContent) {
        recordTextRevision(get().vaultPath ?? "", target.relPath, expectedContent);
      }
      const resolvedIssue = clearTextSaveIssues([key]);
      if (
        resolvedIssue &&
        (get().status.startsWith(`Save failed for ${target.relPath}:`) ||
          get().status.startsWith(`Use disk copy failed for ${target.relPath}:`))
      ) {
        set({ status: `Saved ${target.relPath}.` });
      }

      // Publish extracted graph metadata only for the revision still shown in
      // the cache. A newer edit can arrive while the verified write is in
      // flight; publishing the older snapshot would briefly regress the graph.
      if (get().contentCache[file.relPath] !== content) return;
      const cur = get().notes[file.relPath];
      compactDocument(get().contentCache, file.relPath, content);
      const next = cur ? refreshedNoteMeta(cur, content) : null;
      if (next) set({ notes: { ...get().notes, [file.relPath]: next } });
    },
    onError: ({ key, target }, error) => {
      recordTextSaveIssue(key, target.relPath, String(error));
      set({ status: `Save failed for ${target.relPath}: ${String(error)}` });
    },
  });

  // Calendar and task controls edit vault text outside CodeMirror. Send those
  // mutations through the same per-path queue so they cannot race a pending
  // editor save or overwrite bytes changed by another process. A failure stays
  // dirty and is already exposed through the shared save-recovery UI.
  const saveTextMutation = async (
    file: VaultFile,
    content: string,
    expectedContent: string
  ): Promise<void> => {
    textSaves.markDirty(file.path, file, content, expectedContent);
    try {
      await textSaves.flush(file.path);
    } catch {
      // `onError` records the path and exact failure for retry/recovery.
    }
  };
  // A path is not a lifecycle identity: reopening the same vault must cancel
  // the previous open's scan and background metadata/search work too.
  let vaultOpenGeneration = 0;
  let vaultOpenRequest = 0;
  let unwatch: (() => void) | undefined;
  let watcherSetupGeneration = 0;
  let externalRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // `fileFor` was a linear `find` over every file in the vault, and it is asked
  // on selection, on every viewer render, and up to three times per path inside
  // the watcher loop. At 4,165 files that is 11.2 us a call; a bulk external
  // change (4,500 lookups) spent 34.7 ms in it, versus 0.25 ms indexed. Rebuilt
  // only when the `files` array identity changes — every mutation replaces it —
  // so the index can never answer for a stale file list.
  const fileIndexFor = createFileIndex();
  const pendingContentReads = new Map<string, Promise<string>>();
  // Lazy non-markdown content is evictable. Keep the recency metadata beside
  // the store, not in React state, and clear it on every vault generation so
  // an old vault cannot pin keys in the new one.
  const lazyContentRecency = new Map<string, number>();
  let lazyContentClock = 0;
  const touchLazyContent = (relPath: string): void => {
    lazyContentRecency.set(relPath, ++lazyContentClock);
  };
  // Hover-preview peeks: short-lived, capped, and separate from contentCache
  // (a truncated peek must never be mistaken for the file's real content).
  const peekCache = new Map<string, { text: string; at: number }>();
  const pendingPeekReads = new Map<string, Promise<string>>();
  const readKey = (root: string | null, generation: number, relPath: string) =>
    `${generation}\0${root ?? ""}\0${relPath}`;
  const PEEK_TTL_MS = 10_000;
  const PEEK_CACHE_MAX = 32;
  // --- Deep Research run bookkeeping (module-scope, not React state). -------
  let drSeq = 0;
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
          vaultOpenGeneration
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
      drPatch({ finishRejection: {
        attempt: drFinishRejectionCount, reason, at: Date.now(),
        reportMarkdown: get().deepResearch?.reportDraft ?? "",
      } });
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
    await drStopListening();
    const researchRun = await loadDeepResearchRun();
    drUnlisten = await researchRun.listenDeepResearch(async (evt) => {
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
        if (evt.requestId) {
          void researchRun.respondResearchFinish(runId, evt.requestId, reply).catch((error) => {
            if (get().deepResearch?.runId !== runId) return;
            drPatch({ error: `Could not return Mesa's validation decision to Pi: ${String(error)}` });
          });
        } else if (reply.status === "rejected") {
          // Compatibility with an already-running older bundled extension.
          const sid = currentPiSessionId();
          const failed = (error: unknown) => {
            if (get().deepResearch?.runId !== runId) return;
            void drStopListening();
            drPatch({ phase: "error", launchStage: "error", error: `Could not send finish corrections to Pi: ${String(error)}` });
          };
          if (sid) {
            drRepairPromptedAttempt = drFinishRejectionCount;
            void researchRun.sendResearchPrompt(sid, reply.message).catch(failed);
          }
          else failed("the shared Pi session is unavailable");
        }
      }
    });
    // Observed activity: the loopback server / native harness mirror every REAL
    // browser navigation (`mesa://browse` = the agent's browse tool call,
    // `mesa://harness-nav` = the harness webview actually navigating, incl.
    // redirects and SPA moves). Feeding these into the run means the user sees
    // the true queries and sources even when the model never calls the
    // self-report progress tool. Best-effort — a failed registration only
    // loses observation, never the run.
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
        drNavUnlistens = [
          await listen<string>("mesa://browse", (ev) => observeNavigation(ev.payload)),
          await listen<{ url?: string }>("mesa://harness-nav", (ev) => observeNavigation(ev.payload?.url)),
        ];
      } catch {
        /* observation is best-effort; self-reported progress still flows */
      }
    }
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

  function commitSettings(settings: Settings): void {
    const settingsIssue = persistSettings(settings);
    set({ settings, settingsIssue });
  }

  // Add a file that an agent created/touched but Mesa hasn't scanned yet, so
  // it appears in the sidebar and, when it is text, the graph. Binary files
  // appear in the sidebar but do not get link metadata.
  async function registerExternalFile(
    rel: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const root = get().vaultPath;
    if (!root || get().fileFor(rel) || !isCurrent()) return;
    // One definition of what belongs in a vault, shared with scanVault's walk.
    if (!isIndexableVaultRelPath(rel)) return;
    const base = rel.replace(/.*\//, "");
    const ext = extOf(base);
    const isMarkdown = /^(md|markdown)$/i.test(ext);
    const path = `${root.replace(/\/+$/, "")}/${rel}`;
    const name = stripExt(base);
    const file: VaultFile = { path, relPath: rel, name, ext, isMarkdown };
    if (isTextualVaultFile(file)) {
      let content = "";
      try {
        content = await readNote(file);
      } catch {
        /* may not exist on disk yet (create announced before write) */
      }
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race — already added
      set({
        files: [...get().files, file].sort((a, b) =>
          a.relPath.localeCompare(b.relPath)
        ),
        notes: {
          ...get().notes,
          [rel]: {
            relPath: rel,
            title: name,
            rawLinks: extractLinks(content),
            tags: extractTags(content),
            aliases: extractAliases(content),
            firstImagePath: undefined,
          },
        },
        contentCache: forkContentCache(get().contentCache, { [rel]: content }),
      });
    } else {
      // Binary file — add to the file list so the sidebar shows it, but no
      // text metadata is needed.
      // Best-effort stat for sort ordering.
      try {
        const s = await stat(path);
        file.size = s.size;
        file.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
      } catch {
        /* stat unavailable — name-based sorting still works */
      }
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race
      set({
        files: [...get().files, file].sort((a, b) =>
          a.relPath.localeCompare(b.relPath)
        ),
      });
    }
  }

  async function refreshMissingExternalFiles(
    root: string,
    isCurrent: () => boolean = () => get().vaultPath === root
  ): Promise<void> {
    if (!root || get().vaultPath !== root || !isCurrent()) return;
    const scanned = await scanVault(root);
    if (!isCurrent()) return;
    const latest = get();
    if (latest.vaultPath !== root) return;
    const existing = new Set(latest.files.map((f) => f.relPath));
    const additions = scanned.filter((f) => !existing.has(f.relPath));
    if (additions.length === 0) return;

    const nextNotes = { ...latest.notes };
    const nextCache = forkContentCache(latest.contentCache);
    const textAdditions = additions.filter(isTextualVaultFile);
    // An external create storm can contain thousands of text files. Keep
    // the final state commit atomic, but bound the reads and decoded strings
    // held by the ingestion pass so a watcher/activity burst cannot create one
    // Promise and one full document buffer per file.
    await forEachConcurrent(
      textAdditions,
      STARTUP_TEXT_READ_CONCURRENCY,
      async (f) => {
        const text = await readNote(f);
        if (!isCurrent()) return;
        nextCache[f.relPath] = text;
        nextNotes[f.relPath] = {
          relPath: f.relPath,
          title: f.name,
          rawLinks: extractLinks(text),
          tags: extractTags(text),
          aliases: extractAliases(text),
          firstImagePath: undefined,
        };
      },
      () => !isCurrent()
    );
    if (!isCurrent()) return;
    const current = get();
    const present = new Set(current.files.map((file) => file.relPath));
    const remaining = additions.filter((file) => !present.has(file.relPath));
    const cache = forkContentCache(current.contentCache);
    const notes = { ...current.notes };
    for (const file of remaining) {
      if (!(file.relPath in cache) && file.relPath in nextCache) cache[file.relPath] = nextCache[file.relPath];
      if (!(file.relPath in notes) && file.relPath in nextNotes) notes[file.relPath] = nextNotes[file.relPath];
    }
    set({
      files: [...current.files, ...remaining].sort((a, b) => a.relPath.localeCompare(b.relPath)),
      notes,
      contentCache: cache,
    });
  }

  function scheduleExternalRefresh(
    root: string,
    isCurrent: () => boolean = () => get().vaultPath === root
  ): void {
    if (!root) return;
    if (externalRefreshTimer) clearTimeout(externalRefreshTimer);
    externalRefreshTimer = setTimeout(() => {
      externalRefreshTimer = undefined;
      if (isCurrent()) void refreshMissingExternalFiles(root, isCurrent);
    }, 180);
  }

  // Remove a file from all relevant state maps when it's deleted externally.
  function removeExternalFile(rel: string): void {
    const files = get().files.filter((f) => f.relPath !== rel);
    const notes = { ...get().notes };
    delete notes[rel];
    const contentCache = forkContentCache(get().contentCache);
    delete contentCache[rel];
    const openTabs = get().openTabs.filter((t) => t !== rel);
    let activePath = get().activePath;
    const wasActive = activePath === rel;
    if (wasActive) activePath = null;
    set({
      files,
      notes,
      contentCache,
      openTabs,
      activePath,
      ...(wasActive ? { content: "" } : {}),
      ...(rel === CALENDAR_FILE ? { calendarEvents: [] } : {}),
    });
  }

  // React to external file changes (AI agents / other tools editing the vault):
  // flicker the changed node and refresh its metadata so the graph stays live.
  // Handles creates, modifies, and deletes for ALL file types — not just
  // markdown — so the sidebar, graph, and content cache stay in sync with the
  // filesystem.
  async function handleExternalChange(
    events: VaultWatchEvent[],
    watcherRoot: string,
    watcherGeneration: number
  ) {
    const isCurrent = () =>
      Boolean(watcherRoot) &&
      get().vaultPath === watcherRoot &&
      vaultOpenGeneration === watcherGeneration;
    if (!isCurrent()) return;
    markMesaPerf("watcher-batch", { events: events.length });
    const rootRaw = watcherRoot;
    const seen = new Set<string>();
    // Modify-path results are accumulated and committed ONCE for the batch.
    // Committing per file spread the whole content cache and notes map each
    // time, so a bulk external change — a device sync landing, an agent
    // rewriting a folder, a git checkout inside the vault — cost O(files ×
    // cacheKeys) copies plus one React cascade per file over the whole sidebar.
    // Measured at this vault's dimensions (2,452 cached files): 1,500 changed
    // files spent 576 ms in object copying alone; batched, 0.5 ms. `seen`
    // guarantees each rel is handled at most once per batch, and nothing in the
    // loop reads back the values queued here, so one commit is equivalent.
    const pendingContent = new Map<string, string>();
    const pendingNotes = new Map<string, NoteMeta>();
    let filesDirty = false;
    // `normalizeVaultRelPath` only consults the vault's relPath list for an
    // absolute path that does NOT sit under the vault root — the uncommon case
    // (an aliased/symlinked root, or a tool reporting a resolved path). Building
    // that list per path anyway copied every file in the vault each time: 45.5 ms
    // per 1,500-path batch here, versus 0.8 ms when it is built only when it is
    // actually needed. Memoized on the `files` array identity, which every
    // mutation replaces, so it can never be consulted stale.
    let knownFrom: VaultFile[] | null = null;
    let knownRelPaths: string[] = [];
    const knownRels = (): string[] => {
      const cur = get().files;
      if (knownFrom !== cur) {
        knownFrom = cur;
        knownRelPaths = cur.map((f) => f.relPath);
      }
      return knownRelPaths;
    };
    // A full rescan is `scanVault` over the whole vault. One per batch picks up
    // everything on disk at that moment, so a second one inside the same loop
    // can only repeat work; anything created after it is left to the debounced
    // refresh. Unbounded rescans inside an event handler are what turned a
    // burst of unrecognized paths into a freeze.
    let rescanned = false;
    const rescanOnce = async (): Promise<void> => {
      if (rescanned) return;
      rescanned = true;
      await refreshMissingExternalFiles(rootRaw, isCurrent);
    };
    const flush = () => {
      if (!isCurrent()) return;
      if (!pendingContent.size && !pendingNotes.size && !filesDirty) return;
      const next: Partial<AppState> = {};
      if (pendingContent.size) {
        // Read at flush time, so creates and deletes that committed during the
        // loop are already in the base. `seen` means a rel is never both queued
        // here and removed in the same batch.
        const cache = forkContentCache(get().contentCache);
        let changed = false;
        for (const [rel, text] of pendingContent) {
          const file = get().fileFor(rel);
          // The user can start typing after the disk read but before this batch
          // commits. Never replace that newer local buffer with the queued read.
          if (file && textSaves.isDirty(file.path)) continue;
          cache[rel] = text;
          changed = true;
          if (get().activePath === rel) next.content = text;
          if (rel === CALENDAR_FILE) next.calendarEvents = parseEvents(text);
        }
        if (changed) next.contentCache = cache;
      }
      if (pendingNotes.size) {
        const notes = { ...get().notes };
        let changed = false;
        for (const [rel, meta] of pendingNotes) {
          const file = get().fileFor(rel);
          if (file && textSaves.isDirty(file.path)) continue;
          notes[rel] = meta;
          changed = true;
        }
        if (changed) next.notes = notes;
      }
      // Stat refreshes mutate the VaultFile objects in place; the array copy
      // exists only to give React a new identity to re-render from.
      if (filesDirty) next.files = [...get().files];
      set(next);
    };
    try {
      for (const evt of events) {
        for (const p of evt.paths) {
          if (!isCurrent()) return;
          // Cheap form first: a path under the vault root resolves on the
          // root-prefix branch without the list being read at all.
          let rel = normalizeVaultRelPath(p, rootRaw);
          if (!rel) rel = normalizeVaultRelPath(p, rootRaw, knownRels());
          if (!rel) {
            await rescanOnce();
            if (!isCurrent()) return;
            rel = normalizeVaultRelPath(p, rootRaw, knownRels());
            // Created after this batch's rescan: let the debounced refresh find
            // it instead of scanning the whole vault again mid-loop. Previously
            // such a path was simply dropped.
            if (!rel) scheduleExternalRefresh(rootRaw, isCurrent);
          }
          if (!rel || seen.has(rel)) continue;
          seen.add(rel);

          // Anything scanVault would not index is invisible to Mesa, so there is
          // nothing here to refresh. This covers Mesa's own verified-write
          // artifacts (.x.mesa-*.tmp) and, unlike the basename-only check it
          // replaces, everything under a dot-directory — `.git/index` and its
          // siblings used to reach the rescan fallback and scan the whole vault
          // once per path. See `isIndexableVaultRelPath`.
          if (!isIndexableVaultRelPath(rel)) continue;

          // --- Deletion ---
          if (evt.kind === "remove") {
            const removedFile = get().fileFor(rel);
            if (removedFile) {
              if (textSaves.isDirty(removedFile.path)) {
                set({
                  status:
                    `File deleted outside Mesa; unsaved text was kept for ${rel}.`,
                });
              } else {
                removeExternalFile(rel);
              }
            }
            continue;
          }

          // --- Create or Modify ---
          let file = get().fileFor(rel);
          if (!file) {
            // a brand-new file appeared on disk — register it
            await registerExternalFile(rel, isCurrent);
            if (!isCurrent()) return;
            file = get().fileFor(rel);
            if (!file) {
              await rescanOnce();
              if (!isCurrent()) return;
              file = get().fileFor(rel);
            }
            scheduleExternalRefresh(rootRaw, isCurrent);
            if (file) {
              let detail = "";
              let added = 0;
              if (isTextualVaultFile(file)) {
                const text = await readNote(file);
                if (!isCurrent()) return;
                detail = text.slice(0, 160);
                added = changedLineStats("", text).added;
              }
              bumpActivityAmount(rel, 1.3, "create", undefined, detail, {
                added,
                removed: 0,
              });
            }
            continue;
          }

          // Existing file — refresh content/metadata
          if (isTextualVaultFile(file)) {
            const read = await readNoteResult(file);
            if (!isCurrent()) return;
            if (!read.ok) {
              set({ status: `External change could not be read; keeping cached content for ${rel}.` });
              continue;
            }
            const text = read.text;
            const old = get().contentCache[rel] ?? "";
            if (text === old) continue; // unchanged, or our own in-app save
            // brighter flicker for bigger edits
            const mag = Math.min(1.6, 0.5 + Math.abs(text.length - old.length) / 180);
            bumpActivityAmount(
              rel,
              mag,
              "write",
              undefined,
              changedSnippet(old, text),
              changedLineStats(old, text)
            );
            // A clean active document can accept the disk update. A dirty file
            // cannot: its verified save will detect the changed baseline and
            // keep the local edit retryable instead of overwriting either side.
            if (!textSaves.isDirty(file.path)) {
              const cur = get().notes[rel];
              if (cur) {
                pendingNotes.set(rel, {
                  ...cur,
                  rawLinks: extractLinks(text),
                  tags: extractTags(text),
                  aliases: extractAliases(text),
                });
              }
              pendingContent.set(rel, text);
            }
          } else {
            // Binary file was modified (e.g. an image was replaced).
            // Refresh its stat so sidebar sorting stays accurate.
            if (file.ext === "pdf") {
              // Stale hover thumbnails must not survive an on-disk change.
              invalidatePdfThumb(file.path);
            }
            // A textual file Mesa already holds text for is refreshed exactly like
            // markdown above — see `needsCachedTextRefresh`. Without this the cache
            // kept the old bytes for the rest of the session, so search matched
            // text that was no longer on disk, the editor opened the stale copy,
            // and saving it overwrote the newer file. The document currently being
            // typed in is left alone, the same rule the markdown branch uses.
            if (
              !textSaves.isDirty(file.path) &&
              needsCachedTextRefresh(file, get().contentCache[rel])
            ) {
              const read = await readNoteResult(file);
              if (!isCurrent()) return;
              if (!read.ok) {
                set({ status: `External change could not be read; keeping cached content for ${rel}.` });
                continue;
              }
              const text = read.text;
              // Mesa's own saves land here too; an unchanged read must not churn
              // the cache identity that every text consumer subscribes to.
              if (text !== get().contentCache[rel]) {
                pendingContent.set(rel, text);
              }
            }
            try {
              const s = await stat(file.path);
              if (!isCurrent()) return;
              file.size = s.size;
              file.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
              // Re-render once for the batch, not once per file.
              filesDirty = true;
            } catch {
              /* stat failed — leave as-is */
            }
          }
        }
      }
    } finally {
      // Applies whatever the batch got through even if a later path throws —
      // the per-file commits this replaced had that property too.
      flush();
    }
  }

  async function setupWatcher(root: string) {
    const setupGeneration = ++watcherSetupGeneration;
    try {
      unwatch?.();
    } catch {
      /* ignore */
    }
    unwatch = undefined;
    const generation = vaultOpenGeneration;
    const stop = await watchVault(root, (events) =>
      void handleExternalChange(events, root, generation)
    );
    if (setupGeneration !== watcherSetupGeneration) {
      // A newer vault opened while this watcher was starting. Do not retain a
      // late watcher whose cleanup handle belongs to an older vault.
      stop();
      return;
    }
    unwatch = stop;
  }

  // External agents (or any tool) report file access by POSTing to the Rust
  // server's /activity route, which re-emits an "activity" Tauri event. This is
  // how *reads* light up — filesystem watchers can't see reads. Set up once.
  let activityBridgeReady = false;
  async function setupActivityBridge() {
    if (activityBridgeReady || !IN_TAURI) return;
    activityBridgeReady = true;
    const unlistens: (() => void)[] = [];
    try {
      unlistens.push(await listen<string>("activity", async (ev) => {
        try {
          const raw = ev.payload as unknown;
          const data =
            typeof raw === "string"
              ? (JSON.parse(raw) as Record<string, unknown>)
              : (raw as Record<string, unknown>);
          const opRaw = data.op;
          const op: ActivityOp =
            opRaw === "read" || opRaw === "write" || opRaw === "create"
              ? opRaw
              : "edit";
          const status = data.status ? String(data.status) : undefined;
          const detail = data.detail ? String(data.detail) : undefined;
          const added =
            typeof data.added === "number" ? data.added : Number(data.added ?? 0);
          const removed =
            typeof data.removed === "number"
              ? data.removed
              : Number(data.removed ?? 0);
          const rootRaw = get().vaultPath;
          let rel = normalizeVaultRelPath(
            String(data.path ?? ""),
            rootRaw,
            get().files.map((f) => f.relPath)
          );
          if (!rel && rootRaw) {
            await refreshMissingExternalFiles(rootRaw);
            rel = normalizeVaultRelPath(
              String(data.path ?? ""),
              rootRaw,
              get().files.map((f) => f.relPath)
            );
          }
          if (!rel) return;
          // an agent may reference a file we haven't scanned yet (e.g. one it
          // just created) — register it so it gets a node and can flicker.
          if (!get().fileFor(rel)) await registerExternalFile(rel);
          if (!get().fileFor(rel)) {
            if (rootRaw) await refreshMissingExternalFiles(rootRaw);
          }
          if (!get().fileFor(rel)) return; // still unknown (non-md / no vault)
          const amount = op === "read" ? 0.7 : op === "create" ? 1.3 : 1.0;
          bumpActivityAmount(rel, amount, op, status, detail, {
            added: Number.isFinite(added) ? added : 0,
            removed: Number.isFinite(removed) ? removed : 0,
          });
          if (op !== "read" && rootRaw) scheduleExternalRefresh(rootRaw);
          // Activity cards need only a bounded excerpt. A full ensureContent
          // here let Pi activity bypass the startup search-cache budget and
          // retain every touched text file for the whole session.
          const activityFile = get().fileFor(rel);
          if (activityFile && isTextualVaultFile(activityFile)) {
            void get().ensurePeek(rel);
          }
        } catch {
          /* ignore malformed activity payloads */
        }
      }));
      // Pi's `browse` tool mirrors its navigation here (via the loopback
      // server) so the harness shows what the agent is reading.
      unlistens.push(await listen<string>("mesa://browse", (ev) => {
        const url = String(ev.payload ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return;
        set((s) => ({ piBrowse: { url, seq: (s.piBrowse?.seq ?? 0) + 1 } }));
      }));
    } catch {
      for (const unlisten of unlistens) {
        try {
          unlisten();
        } catch {
          /* best-effort rollback after partial setup */
        }
      }
      activityBridgeReady = false;
      /* @tauri-apps/api/event unavailable */
    }
  }

  // --- sync console bridge -------------------------------------------------
  // The Rust engine emits structured `sync://log` + `sync://progress` events
  // during `sync_run` AND while the embedded server handles an incoming sync
  // (`[serve]` lines); collect them into the store so SyncModal's embedded
  // console renders both directions. Registered once at vault open (so a
  // receiving device misses nothing) and re-ensured before every local sync.
  const syncEvents = createSyncEventBridge({
    get: () => ({ syncLog: get().syncLog }),
    set: (patch) => set(patch),
  });
  const ensureSyncEventBridge = syncEvents.ensure;
  const logSyncLocal = syncEvents.log;

  // Append a freshly created note into all the relevant maps.
  function addNote(file: VaultFile, content: string) {
    bumpActivityAmount(file.relPath, 1.3, "create");
    const notes = {
      ...get().notes,
      [file.relPath]: {
        relPath: file.relPath,
        title: file.name,
        rawLinks: extractLinks(content),
        tags: extractTags(content),
        aliases: extractAliases(content),
        firstImagePath: undefined,
      },
    };
    set({
      files: [...get().files, file].sort((a, b) =>
        a.relPath.localeCompare(b.relPath)
      ),
      notes,
      contentCache: forkContentCache(get().contentCache, { [file.relPath]: content }),
      status: `${Object.keys(notes).length} notes`,
    });
  }

  const bootSettings = loadSettings();
  return {
    vaultPath: null,
    vaultName: "",
    unavailableVault: null,
    recentVaults: initialRecents(),
    calendarEvents: [],
    files: [],
    notes: {},
    contentCache: {},
    openTabs: [],
    activePath: null,
    content: "",
    graphFull: false,
    loading: false,
    status: "",
    textSaveIssues: {},
    textSaveState: { pending: 0, saving: 0, failed: 0 },
    theme: initialTheme(),
    settings: bootSettings.settings,
    settingsIssue: bootSettings.issue,
    retrySettings: () => commitSettings(get().settings),
    paletteOpen: false,
    searchOpen: false,
    searchSeed: "",
    settingsOpen: false,
    diagnosticsOpen: false,
    popoutDoc: null,
    revealTick: 0,
    syncOpen: false,
    syncListening: false,
    syncBusy: false,
    syncStatus: "",
    syncPhase: "idle",
    syncLog: [],
    syncProgress: null,
    syncReport: null,
    syncLastPeerId: null,
    tasksOpen: false,
    helpOpen: false,
    tourOpen: false,
    overlayOpen: false,
    piOverlayOpen: false,
    piBrowse: null,
    deepResearch: null,
    deepResearchSurface: null,
    overlayWindowRequest: null,
    agentOpen: false,
    hoverPreview: null,
    dragView: null,
    draggingFile: null,
    dragGhost: null,
    keyboardFocus: { region: "center", rightIndex: 0 },
    collapsedFolders: {},
    emptyFolders: [],
    unindexedTextFiles: 0,
    indexingTextFiles: 0,

    showHoverPreview: (target, x, y) => set({ hoverPreview: { target, x, y } }),
    hideHoverPreview: () => {
      if (get().hoverPreview) set({ hoverPreview: null });
    },
    setDragView: (d) => set({ dragView: d }),
    setDraggingFile: (rel) => set({ draggingFile: rel }),
    setDragGhost: (ghost) => set({ dragGhost: ghost }),
    setKeyboardFocus: (focus) => set({ keyboardFocus: focus }),
    toggleFolder: (path) =>
      set({
        collapsedFolders: {
          ...get().collapsedFolders,
          [path]: !get().collapsedFolders[path],
        },
      }),
    setCollapsedFolders: (map) => set({ collapsedFolders: map }),

    setTheme: (t) => {
      try {
        localStorage.setItem(THEME_KEY, t);
      } catch {
        /* ignore */
      }
      set({ theme: t });
    },

    setSetting: (key, value) => {
      const safeValue =
        key === "syncPort"
          ? normalizeSyncPort(value, get().settings.syncPort)
          : value;
      const settings = { ...get().settings, [key]: safeValue };
      commitSettings(settings);
      if (key === "syncEnabled" && safeValue === false) {
        void import("./lib/sync").then(({ stopSyncServer }) => stopSyncServer()).catch(() => {});
        void get().cancelCurrentSync();
        set({ syncListening: false, syncStatus: "Sync disabled." });
      }
      if (key === "enableTabs") {
        if (safeValue === false) {
          set({ openTabs: [] });
        } else {
          const active = get().activePath;
          if (active && !get().openTabs.includes(active)) {
            set({ openTabs: [...get().openTabs, active] });
          }
        }
      }
    },

    setPalette: (open) => set({ paletteOpen: open }),
    openSearch: (seed = "") => {
      if (get().overlayOpen) {
        set({
          searchSeed: seed,
          searchOpen: false,
          overlayWindowRequest: { id: "search" },
        });
        return;
      }
      set({ searchSeed: seed, searchOpen: true });
    },
    setSearch: (open) => set({ searchOpen: open }),
    setSearchSeed: (s) => set({ searchSeed: s }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setDiagnosticsOpen: (open) => set({ diagnosticsOpen: open }),
    setSyncOpen: (open) => set({ syncOpen: open }),

    revealActiveFile: () => set((s) => ({ revealTick: s.revealTick + 1 })),
    removeRecentVault: (path) => {
      const root = canonicalRoot(path);
      if (!root) return;
      const recents = forgetRecentVault(get().recentVaults, root);
      void forgetVaultIndex(root);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
        const last = localStorage.getItem(LAST_VAULT_KEY);
        if (last && canonicalRoot(last) === root) {
          localStorage.removeItem(LAST_VAULT_KEY);
        }
      } catch {
        /* ignore */
      }
      set({ recentVaults: recents });
    },

    addPeer: (input, name, fingerprint) => {
      const address = parsePeerInput(input);
      if (!address) return null;
      const peers = get().settings.peers;
      const fp = fingerprint
        ? fingerprint.replace(/[^0-9a-fA-F]/g, "").toLowerCase()
        : undefined;
      const existing = peers.find((p) => p.address === address);
      if (existing) {
        // Learn the fingerprint from discovery if we didn't have one yet.
        if (fp && !existing.fingerprint) {
          get().updatePeer(existing.id, { fingerprint: fp });
        }
        return existing.id;
      }
      const id = `peer-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const peer: SyncPeer = {
        id,
        name: (name && name.trim()) || address,
        address,
        favorite: false,
        fingerprint: fp,
      };
      get().setSetting("peers", [...peers, peer]);
      return id;
    },
    updatePeer: (id, patch) => {
      get().setSetting(
        "peers",
        get().settings.peers.map((p) => (p.id === id ? { ...p, ...patch } : p))
      );
    },
    removePeer: (id) => {
      get().setSetting(
        "peers",
        get().settings.peers.filter((p) => p.id !== id)
      );
    },

    receiveSharedVault: async ({ address, token, name, fingerprint }) => {
      // The caller has already confirmed the address + key reach a Mesa vault
      // and observed its certificate fingerprint. Let the user choose where it
      // lands, then clone into it.
      const root = await pickVault();
      if (!root) return null; // folder picker cancelled

      set({ loading: true, status: "Downloading shared vault…" });
      try {
        // Two-way sync against the freshly chosen folder: an empty folder pulls
        // everything; a non-empty one merges safely (conflicts become copies).
        await ensureSyncEventBridge();
        const { syncWithPeer } = await import("./lib/sync");
        const result = await syncWithPeer(root, address, token, fingerprint ?? null);

        // Remember the key + device so ongoing sync just works.
        if (!get().settings.syncToken.trim()) {
          get().setSetting("syncToken", token);
        }
        if (!get().settings.syncEnabled) {
          get().setSetting("syncEnabled", true);
        }
        get().addPeer(address, name, fingerprint ?? result.fingerprint);

        await get().openVault(root); // scan + display the cloned vault
        set({
          syncStatus: `Cloned shared vault — ↓${result.pulled} file${
            result.pulled === 1 ? "" : "s"
          }`,
        });
        return result;
      } catch (e) {
        set({ loading: false, status: "" });
        throw e instanceof Error ? e : new Error(String(e));
      }
    },

    toggleListen: async () => {
      const s = get();
      if (!s.vaultPath) return;
      if (!s.settings.syncEnabled) {
        set({ syncStatus: "Sync is disabled." });
        return;
      }
      if (s.syncListening) {
        try {
          const { stopSyncServer } = await import("./lib/sync");
          await stopSyncServer();
        } catch {
          /* ignore */
        }
        set({ syncListening: false, syncStatus: "Stopped listening." });
        return;
      }
      if (!s.settings.syncToken) {
        set({ syncStatus: "Set a sync key before receiving." });
        return;
      }
      try {
        const { startSyncServer } = await import("./lib/sync");
        await startSyncServer(s.settings.syncPort, s.settings.syncToken, s.vaultPath);
        set({
          syncListening: true,
          syncStatus: `Listening on port ${s.settings.syncPort}. Add this device's pairing code, LAN IP, or Tailscale name on your other devices.`,
        });
      } catch (e) {
        set({ syncStatus: `Could not start server: ${String(e)}` });
      }
    },

    ...createSyncWorkflow({
      get, set,
      generation: () => vaultOpenGeneration,
      prepare: ensureSyncEventBridge,
      transfer: (root, address, token, fingerprint, retry) =>
        import("./lib/sync").then(({ syncWithPeer }) =>
          syncWithPeer(root, address, token, fingerprint, retry)
        ),
      cancel: () => import("./lib/sync").then(({ cancelSync }) => cancelSync()),
      refresh: refreshMissingExternalFiles,
      log: logSyncLocal,
    }),
    saveConflictReview: async (root, rel, expected, content, copyRel) => {
      const generation = vaultOpenGeneration;
      const current = () => get().vaultPath === root && vaultOpenGeneration === generation;
      if (!current() || get().syncBusy) throw new Error("Finish syncing and reopen this comparison before saving.");
      await textSaves.flushAll();
      if (!current()) throw new Error("The active vault changed. Reopen the comparison.");
      const file = get().fileFor(rel);
      if (!file?.isMarkdown && file?.ext !== "txt") throw new Error("Only Markdown and plain text can be merged here.");
      const disk = await readReviewText(file);
      if (!current() || disk !== expected || textSaves.isDirty(file.path)) {
        throw new Error("The original changed or could not be read. Reopen the comparison before saving.");
      }
      if (content === expected) return "No changes needed. Both copies were kept.";
      const backupRel = conflictBackupPath(rel, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await writeVaultTextFile(root, backupRel, expected, { expectedMissing: true });
      if (!current()) throw new Error("The vault changed. The original was preserved; reopen the comparison.");
      await registerExternalFile(backupRel, current);
      if (!current() || textSaves.isDirty(file.path)) throw new Error("The original changed during review. Both copies were preserved.");
      textSaves.markDirty(file.path, file, content, expected);
      set({ contentCache: forkContentCache(get().contentCache, { [rel]: content }), ...(get().activePath === rel ? { content } : {}) });
      await textSaves.flush(file.path);
      let reviewedRel: string | null = null;
      if (copyRel) {
        const copy = get().fileFor(copyRel);
        if (copy) {
          const reviewedCopy = await renameVaultFile(root, copyRel, reviewedConflictPath(copyRel, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
          reviewedRel = reviewedCopy.relPath;
          const files = get().files.map((candidate) => candidate.relPath === copyRel ? reviewedCopy : candidate).sort((a, b) => a.relPath.localeCompare(b.relPath));
          const contentCache = { ...get().contentCache };
          if (contentCache[copyRel] !== undefined) {
            contentCache[reviewedCopy.relPath] = contentCache[copyRel];
            delete contentCache[copyRel];
          }
          set({ files, contentCache });
        }
      }
      return `Saved ${rel}. Previous text is in ${backupRel}; ${reviewedRel ? `the reviewed conflict copy is ${reviewedRel}.` : "the conflict copy was kept."}`;
    },
    clearSyncLog: () =>
      set({ syncLog: [], syncProgress: null, syncReport: null }),
    setPopoutDoc: (rel) => set({ popoutDoc: rel }),

    openDocWindow: async (relPath) => {
      if (IN_TAURI) {
        try {
          const { WebviewWindow } = await import(
            "@tauri-apps/api/webviewWindow"
          );
          const vault = get().vaultPath ?? "";
          const theme = get().theme;
          const label =
            "doc-" +
            relPath.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 36) +
            "-" +
            Date.now().toString(36);
          const url = `index.html?doc=${encodeURIComponent(
            relPath
          )}&vault=${encodeURIComponent(vault)}&theme=${theme}`;
          const win = new WebviewWindow(label, {
            url,
            title: get().notes[relPath]?.title ?? relPath,
            width: 760,
            height: 860,
            resizable: true,
            ...MESA_WINDOW_CHROME,
          });
          // WebviewWindow creation is asynchronous. A constructor catch does
          // not catch a native failure such as an unavailable WebView2.
          void win.once("tauri://error", (event) => {
            console.warn("[mesa] document window creation failed:", event.payload ?? event);
            set({
              popoutDoc: relPath,
              status: "Document window could not open; restored inside Mesa.",
            });
          });
          return;
        } catch {
          /* fall back to in-app modal */
        }
      }
      set({ popoutDoc: relPath });
    },

    openAgentWindow: async (placement) => {
      if (IN_TAURI) {
        try {
          const { WebviewWindow } = await import(
            "@tauri-apps/api/webviewWindow"
          );
          const vault = get().vaultPath ?? "";
          const theme = get().theme;
          const active = get().activePath;
          const docParam = active ? `&sel=${encodeURIComponent(active)}` : "";
          // Hand off the live Pi session (if this vault already has one
          // running) so the popped-out window reattaches to the same
          // backend `pi` process instead of silently starting a second one.
          // A Tauri WebviewWindow is a separate JS realm, so the new
          // window's copy of AgentPanel's SHARED_PI_SESSION singleton starts
          // out empty even though the real session is still alive — see
          // adoptSharedPiSession in components/AgentPanel.tsx.
          // Tear-out is an attachment, never a second launch. A very fast
          // drag can race AgentSurface's async xterm/Pi startup, so keep the
          // source surface mounted while waiting briefly for its session id.
          let liveSession = getPiSessionSnapshot();
          for (
            let attempt = 0;
            attempt < 40 &&
            (!liveSession.sessionId || liveSession.vaultPath !== vault);
            attempt++
          ) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
            liveSession = getPiSessionSnapshot();
          }
          if (!liveSession.sessionId || liveSession.vaultPath !== vault) {
            throw new Error("Pi is still starting.");
          }
          const sessionParam = `&piSession=${encodeURIComponent(
            liveSession.sessionId
          )}`;
          const label = `agent-${Date.now().toString(36)}`;
          const titleOverlay = /Macintosh|Mac OS X/i.test(navigator.userAgent);
          const url = `index.html?agent=1&vault=${encodeURIComponent(
            vault
          )}&theme=${theme}&agentLabel=${encodeURIComponent(label)}${
            titleOverlay ? "&titleOverlay=1" : ""
          }${docParam}${sessionParam}`;
          let resolveReady: (ready: boolean) => void = () => undefined;
          const ready = new Promise<boolean>((resolve) => {
            resolveReady = resolve;
          });
          let creationFailed = false;
          const stopReadyListener = await listen<{
            label?: string;
            sessionId?: string;
          }>(AGENT_WINDOW_READY_EVENT, (event) => {
            if (
              event.payload?.label === label &&
              typeof event.payload.sessionId === "string"
            ) {
              resolveReady(true);
            }
          });
          try {
            const win = new WebviewWindow(label, {
              url,
              title: `Pi agent — ${get().vaultName || "Mesa"}`,
              width: Math.max(520, placement?.width ?? 980),
              height: Math.max(360, placement?.height ?? 760),
              minWidth: 520,
              minHeight: 360,
              ...(placement ? { x: placement.x, y: placement.y } : {}),
              resizable: true,
              decorations: true,
              ...MESA_WINDOW_CHROME,
              ...(titleOverlay
                ? {
                    titleBarStyle: "overlay" as const,
                    hiddenTitle: true,
                  }
                : {}),
              shadow: true,
              // Create the OS window visibly. The source Pi remains mounted
              // until the child acknowledges PTY adoption, but visibility
              // must not depend on a post-create `show()` mutation or on the
              // detached realm finishing a full vault scan.
              visible: true,
            });
            void win.once("tauri://error", (e) => {
              creationFailed = true;
              console.warn("[mesa] Pi window creation failed:", e.payload ?? e);
              resolveReady(false);
            });
            const timeout = window.setTimeout(
              () => resolveReady(false),
              15_000
            );
            const adopted = await ready;
            window.clearTimeout(timeout);
            if (!adopted) {
              if (creationFailed) {
                await win.close().catch(() => undefined);
                await reclaimMainPiResizeOwnership();
                set({
                  agentOpen: true,
                  status: "Pi window creation failed; restored inside Mesa.",
                });
              } else {
                // A lost/delayed app event is not proof that the visible child
                // failed. Never destroy a potentially adopted, interactive Pi
                // window on a timer; keep the source mounted as the fail-safe.
                set({
                  status:
                    "Pi handoff was not confirmed; both Pi surfaces were kept open.",
                });
              }
              return false;
            }
            // PTY adoption is the handoff boundary. Focus and the initial
            // context mirror are conveniences after that boundary; a stale
            // runtime capability or transient focus denial must never close a
            // visible, adopted Pi window.
            await win.setFocus().catch((error) => {
              console.warn("[mesa] detached Pi focus request failed:", error);
            });
            const current = get();
            await emitTo(
              label,
              AGENT_CONTEXT_EVENT,
              buildAgentContext({
                vaultName: current.vaultName,
                vaultPath: current.vaultPath,
                activePath: current.activePath,
                openTabs: current.openTabs,
                settings: current.settings,
              })
            ).catch((error) => {
              console.warn("[mesa] initial detached Pi context mirror failed:", error);
            });
            return true;
          } finally {
            stopReadyListener();
          }
        } catch (error) {
          await reclaimMainPiResizeOwnership();
          console.warn("[mesa] Pi native window launch failed:", error);
          set({
            status: `Pi tear-out failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          /* fall back to the in-app floating Pi window */
        }
      }
      set({ agentOpen: true });
      return false;
    },

    openResearchWindow: async (placement) => {
      get().openDeepResearch(false);
      if (!IN_TAURI) return false;
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const currentSurface = get().deepResearchSurface;
        if (currentSurface?.startsWith("native:")) {
          const existing = await WebviewWindow.getByLabel(currentSurface.slice("native:".length));
          if (existing) {
            await existing.setFocus();
            return true;
          }
        }
        const vault = get().vaultPath ?? "";
        const theme = get().theme;
        const label = `research-${Date.now().toString(36)}`;
        const surface = `native:${label}`;
        const url = `index.html?research=1&vault=${encodeURIComponent(vault)}&theme=${theme}&researchLabel=${encodeURIComponent(label)}`;
        const titleOverlay = /Macintosh|Mac OS X/i.test(navigator.userAgent);
        const win = new WebviewWindow(label, {
          url,
          title: `Deep Research — ${get().vaultName || "Mesa"}`,
          width: Math.max(520, placement?.width ?? 760),
          height: Math.max(420, placement?.height ?? 820),
          minWidth: 520,
          minHeight: 420,
          ...(placement ? { x: placement.x, y: placement.y } : {}),
          resizable: true,
          decorations: true,
          ...MESA_WINDOW_CHROME,
          ...(titleOverlay ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : {}),
          shadow: true,
          visible: true,
        });
        get().setDeepResearchSurface(surface);
        // Native creation reports errors asynchronously. Restore the shared
        // Research surface in Mesa so a failed WebView2/WKWebView creation
        // cannot leave the run with no visible presentation.
        void win.once("tauri://error", (event) => {
          if (get().deepResearchSurface !== surface) return;
          console.warn("[mesa] Deep Research window creation failed:", event.payload ?? event);
          set({ status: "Deep Research window could not open; restored inside Mesa." });
          get().openDeepResearch(true);
        });
        void win.once("tauri://destroyed", () => {
          if (get().deepResearchSurface === surface) set({ deepResearchSurface: null });
        });
        return true;
      } catch (error) {
        set({ status: `Deep Research tear-out failed: ${String(error)}` });
        return false;
      }
    },

    openVault: async (path) => {
      const picked = path ?? (await pickVault());
      if (!picked) return;
      // Canonicalize here so *every* entry point (startup restore, ?vault=
      // deeplink, recent-row click, zip import, agent panel) stores the exact
      // same spelling as the folder dialog. Otherwise the recents list can hold
      // two forms of one folder and the switcher can't remove it (Windows).
      const root = picked === DEMO_ROOT ? DEMO_ROOT : canonicalRoot(picked);
      if (!root) return;
      const request = ++vaultOpenRequest;
      const requestIsCurrent = () => request === vaultOpenRequest;
      const pendingName =
        root === DEMO_ROOT ? "Demo Vault" : root.split(/[\\/]/).pop() || root;
      const remoteHint = root.replace(/\\/g, "/").startsWith("/Volumes/") || root.replace(/\\/g, "/").startsWith("//");
      set({
        loading: true,
        status: remoteHint
          ? "Reaching the vault over the network…"
          : "Checking the vault folder…",
      });
      // Do this before flushing the current editor, cancelling research, or
      // stopping its watcher. A failed switch must leave the current vault
      // fully operational; startup restore keeps the missing root selected in
      // an explicit retryable state instead of publishing a blank workspace.
      try {
        await assertVaultRootAvailable(root);
      } catch (error) {
        if (!requestIsCurrent()) return;
        set({
          loading: false,
          unavailableVault: {
            root,
            name: pendingName,
            reason: String(error),
          },
          status: `Vault unavailable: ${pendingName}. Reconnect the drive; Mesa will retry automatically.`,
        });
        // A superseded scan may already have stopped the active watcher.
        // Restore it even when this newer request never reached the scan phase.
        const activeRoot = get().vaultPath;
        if (activeRoot && !unwatch) await setupWatcher(activeRoot).catch(() => {});
        return;
      }
      if (!requestIsCurrent()) return;
      set({ unavailableVault: null });
      markMesaPerf("vault-open-requested", {
        native: IN_TAURI,
        filePathProvided: path != null,
      });
      // A vault switch cannot strand a debounce timer whose relative path may
      // also exist in the next vault. Keep the old vault active if any verified
      // save fails, so the user can resolve the conflict without losing text.
      try {
        await textSaves.flushAll();
      } catch {
        if (requestIsCurrent()) {
          set({ loading: false });
          const activeRoot = get().vaultPath;
          if (activeRoot && !unwatch) await setupWatcher(activeRoot).catch(() => {});
        }
        return;
      }
      if (!requestIsCurrent()) return;
      const openGeneration = ++vaultOpenGeneration;
      const isCurrentOpen = () => vaultOpenGeneration === openGeneration && requestIsCurrent();
      try {
      lazyContentRecency.clear();
      lazyContentClock = 0;
      const activeResearch = get().deepResearch;
      if (activeResearch && activeResearch.phase !== "idle") {
        void drStopListening();
        set({
          deepResearch: {
            ...activeResearch,
            phase: "cancelled",
            launchStage: "cancelled",
            changeSet: null,
            error: "Deep Research was cancelled because the active vault changed.",
          },
        });
      }
      // Invalidate and stop the outgoing watcher before the new vault scan.
      // `watchVault` is asynchronous, so a watcher that is still starting can
      // otherwise resolve later and remain attached to the old vault.
      watcherSetupGeneration++;
      try {
        unwatch?.();
      } catch {
        /* ignore */
      }
      unwatch = undefined;
      set({
        loading: true,
        status: remoteHint
          ? "Reaching the vault over the network…"
          : "Looking through the vault…",
      });
      markMesaPerf("vault-scan-start", { rootKind: root.startsWith("/Volumes/") || root.startsWith("//") ? "remote-hint" : "local-or-unknown" });
      // The task memo keys on relPath, so without this the outgoing vault's
      // note contents stay reachable until the dashboard next runs a pass.
      resetVaultTaskMemo();
      // Same reason: the search eligibility memo keys on relPath and holds the
      // text it answered for, so the outgoing vault's strings would stay
      // reachable through it.
      resetSearchEligibility();

      // `size`/`mtime` come from one `stat` IPC round-trip PER FILE — 93% of
      // the scan on the measured vault (1,476 ms of 1,593 ms). Nothing the
      // first frame draws needs them unless the sidebar is sorted by modified
      // or size, so that is the only case that waits; otherwise the metadata
      // lands behind the paint (`loadVaultMetadata` below).
      const needsMetadataNow = SORT_MODES_NEEDING_METADATA.has(
        get().settings.sortMode
      );
      // Crash recovery USED to run first, with its own directory walk — one
      // `read_dir` IPC round-trip per directory (153 on the reference vault,
      // 96% of the whole pre-paint round-trip budget) to find nothing whenever
      // the last session shut down cleanly, which is nearly always. `vault_scan`
      // already visits every one of those directories, so it now returns the
      // artifacts too and the second walk is gone. On Windows each of those
      // round-trips was a UI-thread message plus a forced `RedrawWindow` while
      // WebView2 was still booting; see `src-tauri/src/vaultscan.rs`.
      let discoveredArtifacts: FoundArtifact[] | null = null;
      let files = await scanVault(root, {
        metadata: needsMetadataNow,
        stopped: () => !isCurrentOpen(),
        onArtifacts: (a) => {
          discoveredArtifacts = a;
        },
      });
      markMesaPerf("vault-scan-complete", { files: files.length });
      if (!isCurrentOpen()) return;
      set({ status: `Found ${files.length.toLocaleString()} files. Opening the notes now…` });
      // Never throws; never blocks opening the vault. `null` means this scan
      // could not answer (demo, or no native command) and recovery walks itself.
      const recovered = await recoverWriteArtifacts(
        root,
        () => !isCurrentOpen(),
        discoveredArtifacts
      );
      if (!isCurrentOpen()) return;
      if (recovered.restored.length) {
        console.warn(
          "[mesa] restored files from interrupted saves:",
          recovered.restored
        );
        // A restored file has to be scanned like any other. Re-listing costs one
        // round-trip and only happens when a save was actually interrupted.
        files = await scanVault(root, {
          metadata: needsMetadataNow,
          stopped: () => !isCurrentOpen(),
        });
        if (!isCurrentOpen()) return;
      }
      // Read note contents with bounded parallelism. One live read promise per
      // file made the startup peak scale with the corpus instead of storage
      // throughput.
      //
      // Only MARKDOWN is read here. `buildNotes` needs all of it to produce the
      // note graph, backlinks and tags the first paint renders, so it is
      // genuinely on the critical path. Every other textual file
      // (.txt/.html/.py/.json/…) is read for `searchVault` and nothing else —
      // on the measured vault that is 1,673 of 2,394 reads (70%) and 45.1 MB,
      // and blocking the whole vault open on it bought nothing the first frame
      // could use. `planTextCache` still budgets which of those files are
      // eligible from the scan's own size metadata; `hydrateSearchCorpus`
      // streams them in afterwards and `searchMatch.ts` keeps scanning the
      // larger corpus cheap once they land.
      const textPlan = planTextCache(files, isTextualVaultFile);
      // Real vaults duplicate whole documents (exported logs, saved pages
      // fetched twice or template copies). The temporary interner belongs to
      // deferred non-Markdown hydration; Markdown uses compressed index records.
      const interner = createTextInterner();
      // Bulk reads: one IPC round-trip per VAULT_TEXT_CHUNK files instead of
      // one per file. `readVaultText` falls back to the per-file path (the
      // `readNote` argument's own path) for the demo vault and for shells
      // without the native command.
      const indexed = await loadIndexedNotes({
        root, files, stopped: () => !isCurrentOpen(),
        read: group => readVaultText(root, group),
        fingerprints: rels => IN_TAURI && rels.length
          ? invoke<(string | null)[]>("vault_text_fingerprints", { root, rels })
          : Promise.all(rels.map(async rel => fingerprintText(await readNote(files.find(file => file.relPath === rel)!)))),
      });
      markMesaPerf("vault-markdown-complete", { markdownFiles: Object.keys(indexed.notes).length, reused: indexed.reused, read: indexed.read });
      if (!isCurrentOpen()) { interner.clear(); return; }
      const notes = indexed.notes;
      const cache = indexed.cache;

      // Load the vault's calendar events (calendar.json at the root), if any.
      let calendarEvents: CalEvent[] = [];
      const calFile = files.find((f) => f.relPath === CALENDAR_FILE);
      if (calFile) {
        try {
          calendarEvents = parseEvents(await readNote(calFile));
        } catch {
          /* ignore an unreadable calendar.json */
        }
      }
      if (!isCurrentOpen()) {
        interner.clear();
        return;
      }

      const name =
        root === DEMO_ROOT ? "Demo Vault" : root.split(/[\\/]/).pop() || root;
      // Track recent vaults (most-recent first, deduped, capped) — the real
      // folders only, never the in-browser demo sentinel.
      const recents = rememberRecentVault(
        get().recentVaults,
        root,
        MAX_RECENTS,
        DEMO_ROOT
      );
      // Scanning leaves the outgoing editor mounted. Drain edits made during
      // that scan immediately before the synchronous state swap; after this
      // await, no user event can interleave before `set` replaces the old vault.
      try {
        await textSaves.flushAll();
      } catch {
        interner.clear();
        if (isCurrentOpen()) set({ loading: false });
        return;
      }
      if (!isCurrentOpen()) {
        interner.clear();
        return;
      }
      try {
        localStorage.setItem(LAST_VAULT_KEY, root);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
      } catch {
        /* ignore */
      }

      set({
        vaultPath: root,
        vaultName: name,
        unavailableVault: null,
        recentVaults: recents,
        calendarEvents,
        files,
        notes,
        contentCache: cache,
        openTabs: [],
        activePath: null,
        content: "",
        emptyFolders: [],
        unindexedTextFiles: textPlan.skipped,
        indexingTextFiles: textPlan.extra.length,
        loading: false,
        status: `${Object.keys(notes).length} notes`,
      });
      markMesaPerf("vault-ready", {
        files: files.length,
        notes: Object.keys(notes).length,
        markdownFiles: files.filter((f) => f.isMarkdown).length,
      });

      const first = files.find((f) => f.isMarkdown);
      if (first) await get().selectFile(first.relPath);
      if (!isCurrentOpen()) {
        interner.clear();
        return;
      }

      // Stream the search-only text — and, when it was skipped, the file
      // metadata — in behind the now-usable UI.
      if (!needsMetadataNow) {
        void hydrateVaultMetadata(root, files, isCurrentOpen, get, set);
      }
      void hydrateSearchCorpus(
        root,
        textPlan.extra,
        interner,
        isCurrentOpen,
        get,
        set
      );

      void setupWatcher(root);
      void setupActivityBridge();
      // Register the sync log/progress listener now — not just before a local
      // sync — so INCOMING syncs (this device receiving; `[serve]` lines from
      // the Rust server) fill the console too. Without this, the receiving
      // device dropped every event and showed no console at all.
      void ensureSyncEventBridge().catch((error) => set({ syncStatus: `Sync event setup failed: ${String(error)}` }));
      } catch (error) {
        if (!isCurrentOpen()) return;
        set({ loading: false, unavailableVault: { root, name: pendingName, reason: String(error) }, status: `Vault open failed: ${String(error)}. Reconnect the drive and retry.` });
        const previousRoot = get().vaultPath;
        if (previousRoot) void setupWatcher(previousRoot);
      }
    },

    selectFile: async (relPath) => {
      const file = get().fileFor(relPath);
      if (!file) return;
      const settings = get().settings;
      if (settings.centerView === "empty") {
        commitSettings({
          ...settings,
          ...openViewInWorkspace(settings.centerView, settings.rightStack, "doc"),
        });
      }
      // text/markdown loads content for the editor; media (image/pdf/video)
      // renders from its path, so no content read is needed.
      const textual = isTextualVaultFile(file);
      const tabs = get().settings.enableTabs
        ? get().openTabs.includes(relPath)
          ? get().openTabs
          : [...get().openTabs, relPath]
        : [];
      // Open instantly: switch the active file now, stream the content in as
      // soon as the disk read lands. On a cache hit this is fully synchronous.
      const cached = textual ? get().contentCache[relPath] : "";
      const openRoot = get().vaultPath;
      const openGeneration = vaultOpenGeneration;
      markMesaPerf("file-open-requested", {
        textual,
        cached: cached !== undefined,
      });
      set({ activePath: relPath, content: cached ?? "", openTabs: tabs });
      if (!textual || cached !== undefined) {
        markMesaPerf("file-open-ready", { textual, cached: cached !== undefined });
      }
      if (textual && cached === undefined) {
        const text = await get().ensureContent(relPath);
        // Commit only if this file is still the active one, and prefer the
        // cache (it may contain edits made while the read was in flight).
        if (
          get().activePath === relPath &&
          get().vaultPath === openRoot &&
          vaultOpenGeneration === openGeneration
        ) {
          set({ content: get().contentCache[relPath] ?? text });
          markMesaPerf("file-open-ready", { textual: true, cached: false });
        }
      }
    },

    // Open any file in the MAIN pane (text in the editor, media in a viewer).
    // The separate pop-out window is reserved for graph clicks / tab drag-out /
    // the "Open in new window" context action.
    openFile: async (relPath) => {
      const settings = get().settings;
      if (settings.centerView === "empty") {
        commitSettings({
          ...settings,
          ...openViewInWorkspace(settings.centerView, settings.rightStack, "doc"),
        });
      } else if (settings.centerView !== "doc") {
        commitSettings({
          ...settings,
          ...placeInCenter(settings.centerView, settings.rightStack, "doc"),
        });
      }
      await get().selectFile(relPath);
    },

    openTarget: async (target) => {
      const linkedFile = resolveTextVaultLink(get().files, target);
      if (linkedFile) {
        await get().selectFile(linkedFile.relPath);
        return;
      }
      const id = resolveTarget(get().notes, target);
      if (id) {
        await get().selectFile(id);
        return;
      }
      const root = get().vaultPath;
      if (!root) return;
      const rel = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
      const content = `# ${target}\n\n`;
      let file: VaultFile | undefined;
      await reportingFailure("Create linked note", async () => {
        file = await createNote(root, rel, content);
      });
      if (!file) return;
      addNote(file, content);
      await get().selectFile(file.relPath);
    },

    setContentFromEditor: (text) => {
      const active = get().activePath;
      if (!active) return;
      const prev = get().contentCache[active] ?? get().content;
      const file = get().fileFor(active);
      set({
        content: text,
        contentCache: forkContentCache(get().contentCache, { [active]: text }),
      });
      // tag the edit with the chunk that changed, so the live card highlights it.
      // One keystroke = one short, subtle blip (see activity.ts decay).
      bumpActivityAmount(
        active,
        0.5,
        "edit",
        undefined,
        changedSnippet(prev, text),
        changedLineStats(prev, text)
      );
      if (file) textSaves.markDirty(file.path, file, text, prev);
    },

    // Flush every dirty path. Clean blur/hide/close events perform no writes.
    flushSave: () => {
      return textSaves.flushAll();
    },

    retryTextSaveIssue: async (key) => {
      const issue = get().textSaveIssues[key];
      if (!issue || issue.busy) return;
      if (!textSaves.isDirty(key)) {
        set({
          status:
            `Retry unavailable for ${issue.relPath}; use the disk copy action ` +
            "to resolve the uncertain file state.",
        });
        return;
      }
      setTextSaveIssueBusy(key, "retry");
      try {
        await textSaves.flush(key);
        if (!textSaves.isDirty(key)) {
          clearTextSaveIssues([key]);
          set({ status: `Saved ${issue.relPath}.` });
        }
      } catch {
        // The coordinator records the current failure and keeps the path dirty.
      } finally {
        setTextSaveIssueBusy(key, null);
      }
    },

    useDiskTextForSaveIssue: async (key) => {
      const issue = get().textSaveIssues[key];
      if (!issue || issue.busy) return;
      setTextSaveIssueBusy(key, "disk");
      let saveHold: TextSaveHold<VaultFile> | undefined;
      try {
        // Pause before reading so edits made during the read are included in
        // the confirmation and cannot race a write under the same path.
        saveHold = await textSaves.hold([key], false);
        const file = get().files.find((candidate) => candidate.path === key);
        if (!file || !isTextualVaultFile(file)) {
          throw new Error(`The text file is no longer available: ${issue.relPath}`);
        }
        // `readNote` intentionally converts native read errors to empty text
        // for ordinary previews. Conflict resolution must fail closed instead:
        // an unreadable file is never treated as an empty disk copy.
        const diskText = IN_TAURI
          ? await readTextFileStrict(file.path)
          : await readNote(file);
        const confirmed =
          typeof window !== "undefined" &&
          window.confirm(
            `Use the disk copy of "${file.relPath}"?\n\n` +
              "This replaces Mesa's unsaved changes and cannot be undone."
          );
        if (!confirmed) {
          saveHold.release();
          saveHold = undefined;
          setTextSaveIssueBusy(key, null);
          set({ status: `Kept local changes for ${file.relPath}.` });
          return;
        }

        const current = get().files.find((candidate) => candidate.path === key);
        if (!current || current.relPath !== file.relPath) {
          throw new Error(`The text file changed while it was being reloaded.`);
        }
        const currentMeta = get().notes[file.relPath];
        const nextMeta = currentMeta
          ? refreshedNoteMeta(currentMeta, diskText)
          : null;

        // The synchronous state commit follows immediately after discard, so
        // no event can observe an unpaused dirty entry with stale local text.
        saveHold.discard();
        saveHold = undefined;
        set((state) => {
          const nextIssues = { ...state.textSaveIssues };
          delete nextIssues[key];
          return {
            content:
              state.activePath === file.relPath ? diskText : state.content,
            contentCache: forkContentCache(state.contentCache, { [file.relPath]: diskText }),
            notes: nextMeta
              ? { ...state.notes, [file.relPath]: nextMeta }
              : state.notes,
            calendarEvents:
              file.relPath === CALENDAR_FILE
                ? parseEvents(diskText)
                : state.calendarEvents,
            textSaveIssues: nextIssues,
            status: `Loaded disk copy for ${file.relPath}.`,
          };
        });
      } catch (error) {
        saveHold?.release();
        recordTextSaveIssue(
          key,
          issue.relPath,
          `Use disk copy failed: ${String(error)}`
        );
        set({
          status: `Use disk copy failed for ${issue.relPath}: ${String(error)}`,
        });
      }
    },
    listActiveTextRevisions: () => {
      const root = get().vaultPath;
      const active = get().activePath;
      const file = active ? get().fileFor(active) : null;
      if (!root || !active || !file || !isTextualVaultFile(file)) return [];
      return listTextRevisions(root, active);
    },
    restoreTextRevision: async (revisionId) => {
      const root = get().vaultPath;
      const active = get().activePath;
      const file = active ? get().fileFor(active) : null;
      if (!root || !active || !file || !isTextualVaultFile(file)) {
        throw new Error("Open a text file before restoring a revision.");
      }
      await textSaves.flushAll();
      const revision = listTextRevisions(root, active).find((entry) => entry.id === revisionId);
      if (!revision) throw new Error("That revision is no longer available.");
      const disk = await readNote(file);
      textSaves.markDirty(file.path, file, revision.content, disk);
      set({
        contentCache: forkContentCache(get().contentCache, { [active]: revision.content }),
        content: revision.content,
        status: `Restoring ${active} from local revision history…`,
      });
      await textSaves.flush(file.path);
      set({ status: `Restored ${active} from local revision history.` });
    },
    restoreRecoveryEntry: async (entry) => {
      const root = get().vaultPath;
      if (!root) throw new Error("Open a vault before restoring recovery storage.");
      await textSaves.flushAll();
      const restored = await restoreRecoveryEntry(root, entry);
      set({ status: `Restored ${restored.relPath} from recovery storage.` });
      await get().openVault(root);
      return restored;
    },

    newNote: async () => {
      const root = get().vaultPath;
      if (!root) return;
      await reportingFailure("New note", async () => {
        const existing = new Set(get().files.map((f) => f.relPath.toLowerCase()));
        let rel = "Untitled.md";
        let n = 1;
        while (existing.has(rel.toLowerCase())) rel = `Untitled ${n++}.md`;
        const content = `# ${rel.replace(/\.md$/, "")}\n\n`;
        const file = await createNote(root, rel, content);
        addNote(file, content);
        await get().selectFile(file.relPath);
      });
    },

    // Right-click a folder → New note inside it.
    createChildNote: async (folderPath) => {
      const root = get().vaultPath;
      if (!root) return;
      await reportingFailure("New note", async () => {
        const taken = get().files.map((f) => f.relPath);
        const rel = childRelPath(taken, folderPath, "Untitled", "md");
        const title = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "");
        const file = await createNote(root, rel, `# ${title}\n\n`);
        addNote(file, `# ${title}\n\n`);
        // Expand the folder (and its ancestors) so the new note is visible, and
        // drop the folder from emptyFolders since it now has a file.
        const expand = { ...get().collapsedFolders };
        for (const a of [...ancestorFolders(rel), folderPath]) if (a) expand[a] = false;
        set({
          collapsedFolders: expand,
          emptyFolders: get().emptyFolders.filter((f) => f !== folderPath),
        });
        await get().selectFile(file.relPath);
      });
    },

    saveOverlayArtifact: async (kind, content, date) => {
      const root = get().vaultPath;
      if (!root) {
        set({ status: "Open a vault before you save this item into it." });
        return null;
      }
      const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "")
        ? date!
        : localISO();
      const extension = kind === "scratchpad" ? "md" : "png";
      const folder = kind === "scratchpad" ? "Scratchpad" : "Whiteboard";
      const rel = childRelPath(get().files.map((file) => file.relPath), folder, safeDate, extension);
      let saved: VaultFile | undefined;
      await reportingFailure(`Save ${kind} into vault`, async () => {
        saved =
          kind === "scratchpad"
            ? await writeVaultTextFile(root, rel, String(content), { expectedMissing: true })
            : await writeVaultBinaryFile(
                root,
                rel,
                content instanceof Uint8Array ? content : new Uint8Array(),
                { expectedMissing: true }
              );
      });
      if (!saved) return null;
      if (saved.isMarkdown) {
        addNote(saved, String(content));
      } else {
        bumpActivityAmount(saved.relPath, 1.3, "create");
        set({
          files: [...get().files, saved].sort((a, b) => a.relPath.localeCompare(b.relPath)),
          status: `Saved ${saved.relPath}.`,
        });
      }
      return saved.relPath;
    },

    // Right-click a folder → New folder inside it. Empty folders aren't returned
    // by disk scans, so we track them in session state until they hold a file.
    createChildFolder: async (folderPath) => {
      const root = get().vaultPath;
      if (!root) return;
      await reportingFailure("New folder", async () => {
        const taken = [
          ...get().files.map((f) => f.relPath),
          ...get().emptyFolders,
        ];
        const rel = childRelPath(taken, folderPath, "New folder");
        await createFolder(root, rel);
        const expand = { ...get().collapsedFolders };
        for (const a of [...ancestorFolders(rel), folderPath]) if (a) expand[a] = false;
        set({
          collapsedFolders: expand,
          emptyFolders: [...get().emptyFolders, rel],
        });
      });
    },

    // Duplicate any file (note or asset) next to itself with a " copy" name.
    duplicateEntry: async (relPath) => {
      const root = get().vaultPath;
      const file = get().fileFor(relPath);
      if (!root || !file) return;
      await reportingFailure("Duplicate", async () => {
        const dest = duplicateRelPath(get().files.map((f) => f.relPath), relPath);
        const newFile = await copyVaultFile(root, relPath, dest);
        bumpActivityAmount(newFile.relPath, 1.0, "create");
        if (newFile.isMarkdown) {
          const text = await readNote(newFile);
          set({
            files: [...get().files, newFile].sort((a, b) =>
              a.relPath.localeCompare(b.relPath)
            ),
            notes: {
              ...get().notes,
              [newFile.relPath]: {
                relPath: newFile.relPath,
                title: newFile.name,
                rawLinks: extractLinks(text),
                tags: extractTags(text),
                aliases: extractAliases(text),
                firstImagePath: undefined,
              },
            },
            contentCache: forkContentCache(get().contentCache, { [newFile.relPath]: text }),
          });
          await get().selectFile(newFile.relPath);
        } else {
          set({
            files: [...get().files, newFile].sort((a, b) =>
              a.relPath.localeCompare(b.relPath)
            ),
          });
        }
      });
    },


    // Toggle a file/folder in the sidebar Bookmarks section.
    toggleBookmark: (relPath) => {
      const list = get().settings.bookmarks;
      const next = list.includes(relPath)
        ? list.filter((b) => b !== relPath)
        : [...list, relPath];
      get().setSetting("bookmarks", next);
    },

    setTasksOpen: (open) => set({ tasksOpen: open }),
    setHelpOpen: (open) => set({ helpOpen: open }),
    setTourOpen: (open) => set({ tourOpen: open }),
    setOverlayOpen: (open) =>
      set((s) => ({
        overlayOpen: open,
        // Mutual exclusion: the Steam overlay and the Pi overlay can't coexist
        // (no two Pi agent instances). Opening the Steam overlay closes Pi.
        piOverlayOpen: open ? false : s.piOverlayOpen,
      })),
    toggleOverlay: () => {
      const next = !get().overlayOpen;
      set((s) => ({
        overlayOpen: next,
        // Opening the Steam overlay closes the Pi overlay (mutual exclusion).
        piOverlayOpen: next ? false : s.piOverlayOpen,
      }));
    },
    setPiOverlayOpen: (open) =>
      set((s) => ({
        piOverlayOpen: open,
        // Mutual exclusion: opening the Pi overlay closes the Steam overlay
        // (and its Pi window), so there is never more than one Pi instance.
        overlayOpen: open ? false : s.overlayOpen,
      })),
    setAgentOpen: (open) => set({ agentOpen: open }),
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
      // optionally requests the Steam overlay's Research window. Pi's launcher
      // passes false and owns its slide-out wing instead.
      const cur = get().deepResearch;
      if (!cur) {
        set({
          deepResearch: {
            runId: createRunId(),
            vaultRoot: get().vaultPath,
            vaultGeneration: vaultOpenGeneration,
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
      const runGeneration = vaultOpenGeneration;
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
        if (!researchRunIsCurrent(runId, root, runGeneration)) return; // superseded, cancelled, or vault changed
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
        if (!researchRunIsCurrent(runId, root, runGeneration)) return;
        await drStartListening(runId);
      } catch (e) {
        drPatch({ phase: "error", launchStage: "error", error: `Could not start the Deep Research progress bridge: ${String(e)}` });
        if (currentPiSessionId()) await requestSharedPiRestart();
        return;
      }

      const researchModule = await loadDeepResearch();
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
        if (!researchRunIsCurrent(runId, root, runGeneration)) return;
        await (await loadDeepResearchRun()).sendResearchPrompt(sessionId, prompt);
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
      if (sid) await (await loadDeepResearchRun()).interruptPi(sid);
      await drStopListening();
      drPatch({ phase: "cancelled", launchStage: "cancelled", error: null, changeSet: null });
      if (sid) await requestSharedPiRestart();
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


    openDailyNote: async (dateISO) => {
      const root = get().vaultPath;
      if (!root) return;
      const folder = get().settings.dailyFolder.trim().replace(/^\/+|\/+$/g, "");
      const rel = folder ? `${folder}/${dateISO}.md` : `${dateISO}.md`;
      if (get().fileFor(rel)) {
        await get().selectFile(rel);
        return;
      }
      let body = `# ${dateISO}\n\n`;
      const tf = get().settings.templatesFolder.trim().replace(/^\/+|\/+$/g, "");
      const tplRel = tf ? `${tf}/daily.md` : "daily.md";
      if (get().fileFor(tplRel)) {
        const tpl = await get().ensureContent(tplRel);
        body = applyTemplate(tpl, {
          date: dateISO,
          time: localTime(),
          title: dateISO,
        });
      }
      let file: VaultFile | undefined;
      await reportingFailure("Open daily note", async () => {
        file = await createNote(root, rel, body);
      });
      if (!file) return;
      addNote(file, body);
      await get().selectFile(rel);
    },

    // Calendar events persist in calendar.json at the vault root.
    addCalendarEvent: async (date, title) => {
      const root = get().vaultPath;
      const t = title.trim();
      if (!root || !date || !t) return;
      await reportingFailure("Add calendar event", async () => {
        const found = get().fileFor(CALENDAR_FILE);
        if (found) {
          const loaded = await get().ensureContent(CALENDAR_FILE);
          const file = get().fileFor(CALENDAR_FILE);
          if (!file) throw new Error(`${CALENDAR_FILE} is no longer available.`);
          const prev = get().contentCache[CALENDAR_FILE] ?? loaded;
          const events = [...get().calendarEvents, { date, title: t }];
          const content = serializeEvents(events);
          set({
            calendarEvents: events,
            content:
              get().activePath === CALENDAR_FILE ? content : get().content,
            contentCache: forkContentCache(get().contentCache, { [CALENDAR_FILE]: content }),
          });
          await saveTextMutation(file, content, prev);
          return;
        }

        const events = [...get().calendarEvents, { date, title: t }];
        const content = serializeEvents(events);
        const file = await createNote(root, CALENDAR_FILE, content);
        set({
          files: [...get().files, file].sort((a, b) =>
            a.relPath.localeCompare(b.relPath)
          ),
          calendarEvents: events,
          content:
            get().activePath === CALENDAR_FILE ? content : get().content,
          contentCache: forkContentCache(get().contentCache, { [CALENDAR_FILE]: content }),
        });
      });
    },
    removeCalendarEvent: async (date, title) => {
      if (!get().vaultPath) return;
      await reportingFailure("Remove calendar event", async () => {
        const found = get().fileFor(CALENDAR_FILE);
        if (!found) return;
        const loaded = await get().ensureContent(CALENDAR_FILE);
        const file = get().fileFor(CALENDAR_FILE);
        if (!file) throw new Error(`${CALENDAR_FILE} is no longer available.`);
        const prev = get().contentCache[CALENDAR_FILE] ?? loaded;
        const events = get().calendarEvents.filter(
          (e) => !(e.date === date && e.title === title)
        );
        const content = serializeEvents(events);
        set({
          calendarEvents: events,
          content:
            get().activePath === CALENDAR_FILE ? content : get().content,
          contentCache: forkContentCache(get().contentCache, { [CALENDAR_FILE]: content }),
        });
        await saveTextMutation(file, content, prev);
      });
    },

    // Personal tasks the user adds with the + button live in one note (default
    // Tasks.md). Everything else parsed from the vault counts as agent work.
    addPersonalTask: async (text) => {
      const root = get().vaultPath;
      const body = text.trim();
      if (!root || !body) return;
      const rel = (get().settings.tasksFile || "Tasks.md").trim();
      const line = `- [ ] ${body}`;
      const found = get().fileFor(rel);
      if (found) {
        const loaded = await get().ensureContent(rel);
        const existing = get().fileFor(rel);
        if (!existing) {
          set({ status: `Add task failed: ${rel} is no longer available.` });
          return;
        }
        const cur = get().contentCache[rel] ?? loaded;
        const next = cur.replace(/\s*$/, "") + "\n" + line + "\n";
        const notes = { ...get().notes };
        const m = notes[rel];
        if (m) {
          notes[rel] = {
            ...m,
            rawLinks: extractLinks(next),
            tags: extractTags(next),
            aliases: extractAliases(next),
          };
        }
        set({
          notes,
          content: get().activePath === rel ? next : get().content,
          contentCache: forkContentCache(get().contentCache, { [rel]: next }),
        });
        await saveTextMutation(existing, next, cur);
      } else {
        await reportingFailure("Add task", async () => {
          const content = `# Tasks\n\n${line}\n`;
          const file = await createNote(root, rel, content);
          addNote(file, content);
        });
      }
    },

    updateTask: async (relPath, line, patch) => {
      if (!get().fileFor(relPath)) return;
      const loaded = await get().ensureContent(relPath);
      const file = get().fileFor(relPath);
      if (!file) {
        set({ status: `Update task failed: ${relPath} is no longer available.` });
        return;
      }
      const prev = get().contentCache[relPath] ?? loaded;
      const next = updateTaskLine(prev, line, patch);
      if (next === prev) return;
      set({
        content: get().activePath === relPath ? next : get().content,
        contentCache: forkContentCache(get().contentCache, { [relPath]: next }),
        status: `Updated task in ${relPath}`,
      });
      bumpActivityAmount(
        relPath,
        0.6,
        "edit",
        "Task moved on Kanban board",
        changedSnippet(prev, next),
        changedLineStats(prev, next)
      );
      await saveTextMutation(file, next, prev);
    },

    importDropped: async (paths) => {
      const root = get().vaultPath;
      if (!root) return;
      // A thrown import used to leave "Importing…" on screen permanently, which
      // claims work is still in flight when nothing is — worse than silence.
      await reportingFailure("Import", async () => {
        set({ status: "Importing…" });
        const { created, failures } = await importDroppedPaths(root, paths);
        if (created.length === 0) {
          if (failures.length > 0) {
            throw new Error(
              failures.map(({ name, message }) => `${name}: ${message}`).join("; ")
            );
          }
          set({ status: `${Object.keys(get().notes).length} notes` });
          return;
        }
        const files = [...get().files];
        const notes = { ...get().notes };
        const contentCache = forkContentCache(get().contentCache);
        const existing = new Set(files.map((f) => f.relPath));
        for (const f of created) {
          if (!existing.has(f.relPath)) {
            files.push(f);
            existing.add(f.relPath);
          }
          bumpActivityAmount(f.relPath, 1.0, "create");
          if (f.isMarkdown) {
            const text = await readNote(f);
            contentCache[f.relPath] = text;
            notes[f.relPath] = {
              relPath: f.relPath,
              title: f.name,
              rawLinks: extractLinks(text),
              tags: extractTags(text),
              aliases: extractAliases(text),
              firstImagePath: undefined,
            };
          }
        }
        files.sort((a, b) => a.relPath.localeCompare(b.relPath));
        set({
          files,
          notes,
          contentCache,
        });
        const finalStatus =
          `Imported ${created.length} file${created.length > 1 ? "s" : ""}` +
          (failures.length > 0
            ? `; ${failures.length} failed: ${failures
                .map(({ name, message }) => `${name}: ${message}`)
                .join("; ")}`
            : "");
        if (paths.length === 1 && /\.zip$/i.test(paths[0])) {
          const base =
            paths[0]
              .replace(/\\/g, "/")
              .split("/")
              .pop()
              ?.replace(/\.zip$/i, "") ?? "";
          const zipRoot = base ? `${root.replace(/\/+$/, "")}/${base}` : "";
          if (zipRoot && created.some((f) => f.relPath.startsWith(base + "/"))) {
            await get().openVault(zipRoot);
            set({ status: finalStatus });
            return;
          }
        }
        const firstMd = created.find((f) => f.isMarkdown);
        if (firstMd) await get().selectFile(firstMd.relPath);
        set({ status: finalStatus });
      });
    },

    deleteEntry: async (relPath) => {
      const root = get().vaultPath;
      const file = get().fileFor(relPath);
      const prefix = relPath.replace(/\/+$/g, "") + "/";
      const matches = get().files.filter(
        (f) => f.relPath === relPath || f.relPath.startsWith(prefix)
      );
      if (!root || (!file && matches.length === 0)) return;
      const isFolder = !file && matches.length > 0;
      await reportingFailure("Delete", async () => {
        const keys = matches.map((entry) => entry.path);
        let saveHold: TextSaveHold<VaultFile> | undefined;
        try {
          // Pause every child before awaiting anything. Pending edits are
          // intentionally not written to files the user is deleting, but an
          // in-flight verified write must settle before removal can start.
          saveHold = await textSaves.hold(keys, false);
          if (file) await removeFile(file.path);
          else await removeVaultEntry(root, relPath, true);
          saveHold.discard();
          clearTextSaveIssues(keys);
        } catch (error) {
          saveHold?.release();
          throw error;
        }
        const removed = new Set(matches.map((f) => f.relPath));
        if (file) removed.add(relPath);
        const files = get().files.filter((f) => !removed.has(f.relPath));
        const notes = { ...get().notes };
        for (const rel of removed) delete notes[rel];
        const contentCache = forkContentCache(get().contentCache);
        for (const rel of removed) delete contentCache[rel];
        const tabs = get().openTabs.filter((t) => !removed.has(t));
        let active = get().activePath;
        let content = get().content;
        if (active && removed.has(active)) {
          active = tabs[tabs.length - 1] ?? null;
          content = active ? contentCache[active] ?? "" : "";
        }
        set({
          files,
          notes,
          contentCache,
          openTabs: tabs,
          activePath: active,
          content,
          status: `Moved ${isFolder ? "folder" : "file"} ${relPath} to Mesa recovery storage`,
        });
        if (active && contentCache[active] === undefined) void get().selectFile(active);
      });
    },

    // Renames ANY vault file, preserving its real extension and its bytes.
    // The old implementation was markdown-shaped for every file type: it
    // forced a `.md` suffix (renaming `notes.txt` produced `notes.md` and a
    // phantom graph note) and it moved content through the TEXT pipeline —
    // `ensureContent` returns "" for a binary, so renaming a PDF wrote an
    // empty .md and REMOVED the real document. The move is now one atomic,
    // byte-preserving OS rename (`renameVaultFile`) for every file type, the
    // notes map is only touched for markdown, and a failed rename reports in
    // `status` instead of vanishing into a dropped promise. Pinned by
    // renameNote.test.ts.
    renameNote: async (relPath, newBaseName) => {
      const file = get().fileFor(relPath);
      const root = get().vaultPath;
      if (!file || !root) return;
      const slash = relPath.lastIndexOf("/");
      const dir = slash >= 0 ? relPath.slice(0, slash + 1) : "";
      const base = relPath.slice(slash + 1);
      const dot = base.lastIndexOf(".");
      // Exact spelling from the path, so `Scan.PDF` keeps `.PDF`.
      const realExt = dot > 0 ? base.slice(dot + 1) : "";
      const typed =
        realExt && newBaseName.toLowerCase().endsWith("." + realExt.toLowerCase())
          ? newBaseName.slice(0, -(realExt.length + 1))
          : newBaseName;
      const clean = safeBaseName(typed);
      if (!clean) return;
      const newRel = realExt ? `${dir}${clean}.${realExt}` : `${dir}${clean}`;
      if (newRel === relPath || get().fileFor(newRel)) return;
      const inboundFiles =
        file.isMarkdown
          ? get().files.filter((candidate) =>
              candidate.isMarkdown &&
              candidate.relPath !== relPath &&
              (get().notes[candidate.relPath]?.rawLinks ?? []).some(
                (link) => {
                  const sourceDir = candidate.relPath.includes("/")
                    ? candidate.relPath.slice(0, candidate.relPath.lastIndexOf("/"))
                    : "";
                  return (
                    resolveTarget(get().notes, link) === relPath ||
                    resolveTarget(get().notes, normalizeRelativeTarget(sourceDir, link)) === relPath
                  );
                }
              )
            )
          : [];
      // Hold this identity across the OS rename. Existing edits are flushed to
      // establish the disk baseline; edits typed while rename is in flight stay
      // paused and move to the new absolute key after success.
      let saveHold: TextSaveHold<VaultFile> | undefined;
      let linkHold: TextSaveHold<VaultFile> | undefined;
      let newFile: VaultFile;
      const linkUpdates: Array<{ file: VaultFile; before: string; after: string }> = [];
      try {
        saveHold = await textSaves.hold([file.path], true);
        if (inboundFiles.length) {
          linkHold = await textSaves.hold(inboundFiles.map((candidate) => candidate.path), true);
          for (const inbound of inboundFiles) {
            const before = get().contentCache[inbound.relPath] ?? await readNote(inbound);
            const { text, changed } = rewriteInboundLinks(inbound.relPath, before, relPath, newRel, get().notes);
            if (changed) linkUpdates.push({ file: inbound, before, after: text });
          }
        }
        newFile = await renameVaultFile(root, relPath, newRel);
        saveHold.move(file.path, newFile.path, newFile);
      } catch (e) {
        saveHold?.release();
        linkHold?.release();
        set({ status: `Rename failed: ${String(e)}` });
        return;
      }

      const appliedLinkUpdates: typeof linkUpdates = [];
      let linkUpdateError: string | null = null;
      try {
        for (const update of linkUpdates) {
          await writeNote(update.file, update.after, update.before);
          appliedLinkUpdates.push(update);
        }
      } catch (error) {
        linkUpdateError = String(error);
      } finally {
        linkHold?.release();
      }

      const notes = { ...get().notes };
      const meta = notes[relPath];
      delete notes[relPath];
      const contentCache = forkContentCache(get().contentCache);
      const cachedText = contentCache[relPath];
      if (cachedText !== undefined) {
        contentCache[newRel] = cachedText;
        delete contentCache[relPath];
      }
      if (newFile.isMarkdown) {
        const text = cachedText ?? "";
        notes[newRel] = {
          relPath: newRel,
          title: newFile.name,
          rawLinks: meta?.rawLinks ?? extractLinks(text),
          tags: meta?.tags ?? extractTags(text),
          aliases: meta?.aliases ?? extractAliases(text),
          firstImagePath: meta?.firstImagePath,
        };
      }
      for (const update of appliedLinkUpdates) {
        contentCache[update.file.relPath] = update.after;
        notes[update.file.relPath] = {
          relPath: update.file.relPath,
          title: update.file.name,
          rawLinks: extractLinks(update.after),
          tags: extractTags(update.after),
          aliases: extractAliases(update.after),
        };
      }
      const files = get()
        .files.filter((f) => f.relPath !== relPath)
        .concat(newFile)
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
      const openTabs = get().openTabs.map((t) => (t === relPath ? newRel : t));
      const activePath = get().activePath === relPath ? newRel : get().activePath;
      const activeContent =
        activePath && contentCache[activePath] !== undefined
          ? contentCache[activePath]
          : get().content;
      set({
        files,
        notes,
        contentCache,
        openTabs,
        activePath,
        content: activeContent,
        status: linkUpdateError
          ? `Renamed ${relPath}, but updating inbound links stopped: ${linkUpdateError}`
          : appliedLinkUpdates.length
          ? `Renamed ${relPath} and updated ${appliedLinkUpdates.length} inbound ${appliedLinkUpdates.length === 1 ? "link" : "links"}`
          : `Renamed ${relPath}`,
      });
    },

    closeTab: (relPath) => {
      const closingFile = get().fileFor(relPath);
      // The dirty record is independent of tab state. Start its drain now; a
      // later window close or vault switch will await the same promise.
      if (closingFile) {
        void textSaves.flush(closingFile.path).catch(() => undefined);
      }
      const tabs = get().openTabs.filter((t) => t !== relPath);
      let active = get().activePath;
      let content = get().content;
      if (active === relPath) {
        active = tabs[tabs.length - 1] ?? null;
        content = active ? get().contentCache[active] ?? "" : "";
      }
      set({ openTabs: tabs, activePath: active, content });
      if (active && get().contentCache[active] === undefined) {
        void get().selectFile(active);
      }
    },

    ...createWorkspaceActions({ get, set: (patch) => set(patch as Partial<AppState>), commitSettings, setSetting: (key, value) => get().setSetting(key as never, value as never) }),
    /* Workspace actions are owned by lib/workspaceActions.ts. */
    /* legacy action block follows only for window creation. */
    openPanelWindow: async (panel, placement) => {
      if (!IN_TAURI) return;
      const dockPanel = () => {
        /* fall back: just dock it in the right stack */
        const settings = get().settings;
        get().setSetting(
          "centerView",
          settings.centerView === "empty" ? panel : settings.centerView
        );
        if (settings.centerView !== "empty" && !settings.rightStack.includes(panel)) {
          get().setSetting("rightStack", [...settings.rightStack, panel]);
        } else if (settings.centerView === "empty") {
          get().setSetting("rightStack", []);
        }
      };
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const vault = get().vaultPath ?? "";
        const theme = get().theme;
        // A panel is a singleton surface. Timestamped labels made every
        // repeated tear-out create another Mesa window, which macOS then
        // displayed as a second app thumbnail. Reuse the stable panel label.
        const label = `panel-${panel}`;
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
          await existing.setFocus();
          return;
        }
        // Preview/Tasks/Calendar follow the active note — carry it so the popped
        // window shows the SAME document, not the vault's first note.
        const active = get().activePath;
        const docParam = active ? `&sel=${encodeURIComponent(active)}` : "";
        const graphBootstrapSaved =
          panel === "graph" && vault
            ? saveGraphWindowBootstrap(label, {
                vaultPath: vault,
                vaultName: get().vaultName,
                files: get().files,
                notes: get().notes,
                settings: {
                  hardwareAccel: get().settings.hardwareAccel,
                  animations: get().settings.animations,
                  graphShowTags: get().settings.graphShowTags,
                  graphExistingFilesOnly: get().settings.graphExistingFilesOnly,
                  graphShowOrphans: get().settings.graphShowOrphans,
                  graphShowAttachments: get().settings.graphShowAttachments,
                  graphArrows: get().settings.graphArrows,
                  graphTextFadeThreshold: get().settings.graphTextFadeThreshold,
                  graphNodeSize: get().settings.graphNodeSize,
                  graphLinkThickness: get().settings.graphLinkThickness,
                  graphCenterForce: get().settings.graphCenterForce,
                  graphRepelForce: get().settings.graphRepelForce,
                  graphLinkForce: get().settings.graphLinkForce,
                  graphLinkDistance: get().settings.graphLinkDistance,
                },
              })
            : false;
        const bootstrapParam = graphBootstrapSaved
          ? `&graphBootstrap=${encodeURIComponent(label)}`
          : "";
        if (graphBootstrapSaved) {
          window.setTimeout(() => discardGraphWindowBootstrap(label), 30_000);
        }
        const url = `index.html?panel=${panel}&vault=${encodeURIComponent(
          vault
        )}&theme=${theme}${docParam}${bootstrapParam}`;
        const win = new WebviewWindow(label, {
          url,
          title: panel[0].toUpperCase() + panel.slice(1),
          width: Math.max(360, placement?.width ?? 720),
          height: Math.max(280, placement?.height ?? 820),
          ...(placement ? { x: placement.x, y: placement.y } : {}),
          resizable: true,
          // Graph keeps the OS-following chrome contract. Other Mesa-owned
          // panel windows need the same dark launch background as the main
          // window so WebView2 does not flash white before React paints.
          ...(panel === "graph" ? {} : MESA_WINDOW_CHROME),
        });
        // The constructor only starts the native request. Handle a real
        // creation error as well as the synchronous import/constructor path.
        void win.once("tauri://error", (event) => {
          console.warn(`[mesa] ${panel} window creation failed:`, event.payload ?? event);
          dockPanel();
        });
      } catch {
        dockPanel();
      }
    },

    ensureContent: async (relPath) => {
      const root = get().vaultPath;
      const generation = vaultOpenGeneration;
      const key = readKey(root, generation, relPath);
      const file = get().fileFor(relPath);
      if (!file) return "";
      const cached = get().contentCache[relPath];
      if (cached !== undefined) {
        if (!file.isMarkdown) touchLazyContent(relPath);
        return cached;
      }
      const pending = pendingContentReads.get(key);
      if (pending) return pending;
      // Never pull a non-text file through the text pipeline. `readNote`
      // decodes bytes as UTF-8, so caching a PDF/image here would put a lossy
      // decode of it into `contentCache` — content every text consumer,
      // including the crash-safety flush, would then treat as that file's real
      // text. Callers of this are the text surfaces (editor, code/html/rtf
      // views); the activity bridge also calls it for whatever path an agent
      // touched, which is exactly how a binary could get in.
      if (!isTextualVaultFile(file)) return "";
      const read = readNote(file)
        .then((text) => {
          // If newer content landed in the cache while the disk read was in
          // flight (the user typed, an agent wrote), the cache wins — never
          // clobber live edits with stale disk bytes.
          const existing = get().contentCache[relPath];
          if (existing !== undefined) return existing;
          const current = get().fileFor(relPath);
          if (
            vaultOpenGeneration === generation &&
            get().vaultPath === root &&
            current?.path === file.path
          ) {
            touchLazyContent(relPath);
            const state = get();
            const pinned = new Set<string>();
            for (const candidate of state.files) {
              if (
                candidate.relPath === state.activePath ||
                textSaves.isDirty(candidate.path)
              ) {
                pinned.add(candidate.relPath);
              }
            }
            const cache = forkContentCache(state.contentCache, { [relPath]: text });
            const bounded = retainLazyTextCache(
              cache,
              state.files,
              isTextualVaultFile,
              lazyContentRecency,
              pinned
            );
            set(bounded === state.contentCache ? {} : { contentCache: bounded });
          }
          return vaultOpenGeneration === generation && get().vaultPath === root
            ? text
            : "";
        })
        .finally(() => {
          if (pendingContentReads.get(key) === read) pendingContentReads.delete(key);
        });
      pendingContentReads.set(key, read);
      return read;
    },

    ensurePeek: async (relPath) => {
      const full = get().contentCache[relPath];
      if (full !== undefined) return full;
      const root = get().vaultPath;
      const generation = vaultOpenGeneration;
      const key = readKey(root, generation, relPath);
      const now = Date.now();
      const hit = peekCache.get(key);
      if (hit && now - hit.at < PEEK_TTL_MS) return hit.text;
      const pending = pendingPeekReads.get(key);
      if (pending) return pending;
      const file = get().fileFor(relPath);
      if (!file) return "";
      const read = peekNote(file)
        .then((text) => {
          if (vaultOpenGeneration !== generation || get().vaultPath !== root) return "";
          peekCache.set(key, { text, at: Date.now() });
          // Tiny LRU-ish cap: drop the oldest insertion once past the cap.
          if (peekCache.size > PEEK_CACHE_MAX) {
            const oldest = peekCache.keys().next().value;
            if (oldest !== undefined) peekCache.delete(oldest);
          }
          return text;
        })
        .finally(() => {
          if (pendingPeekReads.get(key) === read) pendingPeekReads.delete(key);
        });
      pendingPeekReads.set(key, read);
      return read;
    },

    fileFor: (relPath) => fileIndexFor(get().files).get(relPath),
  };
});

/** Convenience for non-react callers. */
export function getStore() {
  return useAppStore.getState();
}
