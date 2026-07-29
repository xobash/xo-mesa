import { create } from "zustand";
import type {
  VaultFile,
  NoteMeta,
  RightPanel,
  Settings,
  SyncPeer,
  PreviewTarget,
  PaneView,
} from "./types";
import {
  placeInCenter,
  placeInRight,
  closeCenterView,
  removeFromWorkspace,
  toggleWorkspacePanel,
  openViewInWorkspace,
  type PaneDrag,
} from "./lib/panes";
import {
  pickVault,
  scanVault,
  readNote,
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
  isTextualVaultFile,
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
  type VaultWatchEvent,
} from "./lib/vault";
import { buildNotes, refreshedNoteMeta, resolveTarget } from "./lib/graph";
import { childRelPath, duplicateRelPath, ancestorFolders, safeBaseName } from "./lib/fsnames";
import { extractLinks, extractTags, extractAliases } from "./lib/markdownExtract";
import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet,
  type ActivityOp,
} from "./lib/activity";
import {
  startSyncServer,
  stopSyncServer,
  syncWithPeer,
  SYNC_LOG_EVENT,
  SYNC_PROGRESS_EVENT,
  type SyncLogEntry,
  type SyncProgress,
  type SyncReport,
} from "./lib/sync";
import { normalizeSyncPort, parsePeerInput } from "./lib/pairing";
import { generateDeviceName } from "./lib/deviceName";
import type { KeyboardFocus } from "./lib/keyboardNav";
import {
  applyTemplate,
  localTime,
  parseEvents,
  serializeEvents,
  type CalEvent,
} from "./lib/daily";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { stat } from "@tauri-apps/plugin-fs";
import { planKeyMigration } from "./lib/migrate";
import { invalidatePdfThumb } from "./lib/pdfThumb";
import { forgetRecentVault, rememberRecentVault } from "./lib/recentVaults";
import { planTextCache } from "./lib/textCachePlan";
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
import {
  discardGraphWindowBootstrap,
  saveGraphWindowBootstrap,
} from "./lib/graphWindowBootstrap";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  clampDepth,
  limitsForDepth,
  buildResearchContext,
  buildResearchPrompt,
  buildChangeSet,
  createRunId,
  validateResearchResult,
  researchReportQualityIssues,
  canonicalizeSourceUrl,
  truncateUtf8,
  activityForNavigation,
  utf8ByteLength,
  type DeepResearchPhase,
  type DeepResearchLaunchStage,
  type DeepResearchResult,
  type DeepResearchContext,
  type ResearchChangeSet,
  type ResearchContextScope,
  type ResearchDepth,
  type ResearchActivity,
} from "./lib/deepResearch";
import {
  currentPiSessionId,
  sendResearchPrompt,
  interruptPi,
  listenDeepResearch,
  applyChangeSet,
  resolveApplyPlan,
} from "./lib/deepResearchRun";
import { explainResearchTimeout } from "./lib/deepResearchDiagnostics";
import {
  archiveWebPage,
  queueAcceptedResearchSources,
  researchArchiveRelPaths,
  type ArchiveFetchedPage,
} from "./lib/webArchive";

const CALENDAR_FILE = "calendar.json";

const LAST_VAULT_KEY = "mesa:lastVault";
const THEME_KEY = "mesa:theme";
const SETTINGS_KEY = "mesa:settings";
const RECENTS_KEY = "mesa:recentVaults";

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
const MAX_RECENTS = 8;

interface DragGhost {
  kind: "view" | "file";
  label: string;
  x: number;
  y: number;
}

/** The live state of one Deep Research run. Both Deep Research surfaces read
 *  and drive this single object; only one run exists at a time. */
export interface DeepResearchRunState {
  runId: string;
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
    archiveStatus?: "saving" | "saved" | "failed";
    archiveRelPath?: string;
    archiveKind?: "page" | "link";
    archiveError?: string;
  }[];
  /** Latest report snapshot sent while Pi is assembling the deliverable. */
  reportDraft: string;
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

function initialRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      // Canonicalize + dedupe so pre-existing entries saved in a different
      // spelling (e.g. Windows backslash paths) match the canonical form Mesa
      // now uses, and can be removed from the switcher.
      const seen = new Set<string>();
      const healed: string[] = [];
      for (const r of raw) {
        if (typeof r !== "string") continue;
        const c = canonicalRoot(r);
        if (!c || seen.has(c)) continue;
        seen.add(c);
        healed.push(c);
      }
      return healed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

// One-time migration for the Telperion→Mesa rename: earlier builds persisted
// under a `telperion:` localStorage prefix. Copy any such keys to the current
// `mesa:` prefix (without clobbering newer values) so a user's theme, last
// vault, settings, panel choice, and tour state all survive the rename. Runs at
// module load — before the initial* helpers below read the new keys — and is a
// no-op once migrated. The planning logic is the pure, tested `planKeyMigration`.
function migrateLegacyKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const moves = planKeyMigration(
      keys,
      "telperion:",
      "mesa:",
      (key) => localStorage.getItem(key) !== null
    );
    for (const { from, to } of moves) {
      const v = localStorage.getItem(from);
      if (v !== null) localStorage.setItem(to, v);
    }
  } catch {
    /* localStorage unavailable — nothing to migrate */
  }
}
migrateLegacyKeys();

const DEFAULT_SETTINGS: Settings = {
  hoverDelayMs: 450,
  hardwareAccel: true,
  animations: true,
  enableTabs: false,
  syncPort: 8787,
  syncEnabled: true,
  syncDiscovery: true,
  syncToken: "",
  syncDeviceName: "",
  syncAutoMinutes: 0,
  peers: [],
  sortMode: "name",
  sortDir: "asc",
  foldersFirst: true,
  typeFilter: "all",
  dailyFolder: "Daily",
  templatesFolder: "Templates",
  tasksFile: "Tasks.md",
  researchFolder: "Research",
  researchDepth: "standard",
  researchContextScope: "workspace",
  sidebarOpen: true,
  sidebarWidth: 240,
  rightWidth: 380,
  tagsCollapsed: false,
  bookmarks: [],
  bookmarksCollapsed: false,
  sidebarAutoHide: false,
  graphShowTags: false,
  graphExistingFilesOnly: true,
  graphShowOrphans: true,
  graphShowAttachments: false,
  centerView: "doc",
  rightStack: ["preview"],
  dockSide: "right",
  agentProvider: "manual",
  agentModel: "gpt-4.1-mini",
  agentEndpoint: "",
  agentApiKey: "",
};

function initialSettings(): Settings {
  let settings: Settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings> & {
        graphMinDegree?: number;
        syncPeers?: string[];
      };
      // Migrate the old flat `syncPeers: string[]` to rich peer objects.
      if (!parsed.peers && Array.isArray(parsed.syncPeers)) {
        parsed.peers = parsed.syncPeers.map((addr, i) => ({
          id: `peer-${Date.now().toString(36)}-${i}`,
          name: addr,
          address: addr,
          favorite: false,
        }));
      }
      delete parsed.graphMinDegree;
      delete parsed.syncPeers;
      settings = { ...DEFAULT_SETTINGS, ...parsed };
      settings.syncPort = normalizeSyncPort(
        settings.syncPort,
        DEFAULT_SETTINGS.syncPort
      );
    }
  } catch {
    /* ignore */
  }
  // First launch (or pre-name settings): mint this device's LocalSend-style
  // name once and persist it immediately so it stays stable across restarts.
  if (!settings.syncDeviceName?.trim()) {
    settings.syncDeviceName = generateDeviceName();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* localStorage unavailable — name regenerates next launch */
    }
  }
  return settings;
}

export type ThemeId = "system" | "void" | "darkroom";

export const THEMES: { id: ThemeId; label: string; blurb: string }[] = [
  { id: "system", label: "System", blurb: "Neutral, follows OS light/dark" },
  { id: "void", label: "Void", blurb: "Violet pulse on black" },
  { id: "darkroom", label: "Darkroom", blurb: "Cinematic monochrome" },
];

const THEME_IDS: ThemeId[] = ["system", "void", "darkroom"];

function initialTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_KEY) as ThemeId | null;
    if (t && THEME_IDS.includes(t)) return t;
  } catch {
    /* ignore */
  }
  return "system";
}

interface AppState {
  vaultPath: string | null;
  vaultName: string;
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
  theme: ThemeId;
  settings: Settings;

  // transient UI
  /** Bumped to trigger a one-shot "reveal active file" in the file tree. */
  revealTick: number;
  paletteOpen: boolean;
  searchOpen: boolean;
  searchSeed: string;
  settingsOpen: boolean;
  popoutDoc: string | null;
  syncOpen: boolean;
  syncListening: boolean;
  syncBusy: boolean;
  syncStatus: string;
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
  /** Set by `openDeepResearch` to tell the Steam overlay to open and focus
   *  the Deep Research window (a monotonic token; the overlay watches it).
   *  Pi's own launcher passes `false` and opens its local slide-out wing
   *  instead, so the two entry points never create duplicate windows. */
  deepResearchOpenToken: number;
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
  /** Open/refresh the shared Deep Research surface state. Both launchers (the
   *  Steam-overlay dock and the Pi panel button) call this one opener so they
   *  always drive the same active run. */
  openDeepResearch: (openOverlay?: boolean) => void;
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
  setSearch: (open: boolean) => void;
  setSearchSeed: (s: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setPopoutDoc: (rel: string | null) => void;
  setSyncOpen: (open: boolean) => void;
  /** Reveal the active file in the sidebar once (expand + scroll into view). */
  revealActiveFile: () => void;
  toggleListen: () => Promise<void>;
  syncNow: (peerId: string) => Promise<void>;
  syncAll: () => Promise<void>;
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
  openVault: (path?: string) => Promise<void>;
  removeRecentVault: (path: string) => void;
  selectFile: (relPath: string) => Promise<void>;
  openFile: (relPath: string) => Promise<void>;
  openTarget: (target: string) => Promise<void>;
  setContentFromEditor: (text: string) => void;
  flushSave: () => void;
  newNote: () => Promise<void>;
  createChildNote: (folderPath: string) => Promise<void>;
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
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let unwatch: (() => void) | undefined;
  let externalRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // `fileFor` was a linear `find` over every file in the vault, and it is asked
  // on selection, on every viewer render, and up to three times per path inside
  // the watcher loop. At 4,165 files that is 11.2 us a call; a bulk external
  // change (4,500 lookups) spent 34.7 ms in it, versus 0.25 ms indexed. Rebuilt
  // only when the `files` array identity changes — every mutation replaces it —
  // so the index can never answer for a stale file list.
  let fileIndexFrom: VaultFile[] | null = null;
  let fileIndex = new Map<string, VaultFile>();
  const fileIndexFor = (files: VaultFile[]): Map<string, VaultFile> => {
    if (fileIndexFrom !== files) {
      fileIndexFrom = files;
      fileIndex = new Map();
      // `find` returns the FIRST match; keep that exact semantic.
      for (const f of files) if (!fileIndex.has(f.relPath)) fileIndex.set(f.relPath, f);
    }
    return fileIndex;
  };
  const pendingContentReads = new Map<string, Promise<string>>();
  // Hover-preview peeks: short-lived, capped, and separate from contentCache
  // (a truncated peek must never be mistaken for the file's real content).
  const peekCache = new Map<string, { text: string; at: number }>();
  const pendingPeekReads = new Map<string, Promise<string>>();
  const PEEK_TTL_MS = 10_000;
  const PEEK_CACHE_MAX = 32;
  // --- Deep Research run bookkeeping (module-scope, not React state). -------
  let drSeq = 0;
  let drUnlisten: (() => void) | null = null;
  let drNavUnlistens: (() => void)[] = [];
  let drLastObservedUrl: string | null = null;
  let drLastEventAt = 0;
  let drTimeout: ReturnType<typeof setTimeout> | undefined;
  // INACTIVITY window, not a whole-run budget: a slow provider that keeps
  // reporting progress (or keeps browsing) is never killed mid-run; the run
  // fails only after this long with zero progress AND zero observed browsing.
  const DR_TIMEOUT_MS = 6 * 60 * 1000;

  const drPatch = (patch: Partial<DeepResearchRunState>) => {
    const cur = get().deepResearch;
    if (cur) set({ deepResearch: { ...cur, ...patch } });
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
    sources: DeepResearchResult["sources"],
    archiveStartedAt: number
  ): Promise<void> {
    const relPaths = researchArchiveRelPaths(
      sources.map((source) => source.url),
      archiveStartedAt
    );
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < sources.length) {
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
                await writeVaultTextFile(root, targetRelPath, html, {
                  expectedMissing: true,
                });
              },
            },
            { relPath }
          );
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
          if (get().vaultPath === root) {
            await registerExternalFile(archived.relPath);
          }
          drPatchSource(runId, source.url, {
            archiveStatus: "saved",
            archiveRelPath: archived.relPath,
            archiveKind: archived.linkRecord ? "link" : "page",
            archiveError: archived.warning,
          });
        } catch (error) {
          drPatchSource(runId, source.url, {
            archiveStatus: "failed",
            archiveError:
              error instanceof Error ? error.message : String(error),
          });
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
  function drFinish(runId: string, rawResult: unknown) {
    const cur = get().deepResearch;
    if (!cur || cur.runId !== runId) return;
    drPatch({ launchStage: "finishing" });
    if (!rawResult || typeof rawResult !== "object") {
      drPatch({
        phase: "error",
        launchStage: "error",
        error:
          "Pi called deep_research_finish but its result payload was not a structured object. " +
          "The model produced the finish call without a valid JSON envelope — check the Pi terminal " +
          "scrollback for what it actually emitted, then run again (a stronger model usually fixes this).",
      });
      return;
    }
    const limits = limitsForDepth(DEFAULT_DEEP_RESEARCH_LIMITS, cur.depth);
    const result = validateResearchResult(rawResult as DeepResearchResult, limits);
    if (!result.report.markdown.trim()) {
      drPatch({
        phase: "error",
        launchStage: "error",
        error:
          "Pi finished the run but the validated result contains no report markdown " +
          "(report.markdown was empty or not a string after validation). Check the Pi terminal " +
          "scrollback for the raw finish payload, then run again.",
      });
      return;
    }
    const qualityIssues = researchReportQualityIssues(result, cur.depth);
    if (qualityIssues.length) {
      void drStopListening();
      drPatch({
        phase: "error",
        launchStage: "error",
        error:
          "Pi finished, but its report failed the thesis-grade research contract:\n- " +
          qualityIssues.join("\n- ") +
          "\nMesa rejects incomplete reports rather than offering them for review. " +
          "Run again, increase the depth, or try a stronger model if this repeats.",
      });
      return;
    }
    const folder = get().settings.researchFolder || "Research";
    const changeSet = buildChangeSet({
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
    });
    if (root && IN_TAURI && result.sources.length > 0) {
      void drArchiveAcceptedSources(
        runId,
        root,
        result.sources,
        archiveStartedAt
      );
    }
  }

  async function drStartListening(runId: string) {
    await drStopListening();
    drUnlisten = await listenDeepResearch((evt) => {
      const cur = get().deepResearch;
      if (!cur || cur.runId !== runId || evt.runId !== runId) return;
      drLastEventAt = Date.now();
      if (evt.kind === "progress") {
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
              : [...sources, { url: sourceUrl, title: evt.sourceTitle, status: "reading" }];
          } else if (kind === "note") {
            sources = existing
              ? sources.map((s) => (s.url === sourceUrl ? { ...s, status: "done", title: evt.sourceTitle ?? s.title } : s))
              : [...sources, { url: sourceUrl, title: evt.sourceTitle, status: "done" }];
          }
        }
        sources = sources.slice(0, cur.depth.maxSources);
        set({
          deepResearch: {
          ...cur,
          phase: phase === "planning" || phase === "synthesizing" ? phase : "researching",
          launchStage: "active",
          firstSignalAt: cur.firstSignalAt ?? Date.now(),
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
      } else if (evt.kind === "finish") {
        drFinish(runId, evt.result);
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
      if (cur.phase !== "planning" && cur.phase !== "researching" && cur.phase !== "synthesizing") return;
      const activity = activityForNavigation(String(rawUrl ?? ""), Date.now());
      if (!activity?.sourceUrl) return;
      // browse + harness-nav both fire for one navigation — collapse the echo.
      if (activity.sourceUrl === drLastObservedUrl) return;
      drLastObservedUrl = activity.sourceUrl;
      drLastEventAt = Date.now();
      let sources = cur.sources;
      if (activity.kind === "source" && !sources.some((s) => s.url === activity.sourceUrl)) {
        sources = [...sources, { url: activity.sourceUrl, title: activity.sourceTitle, status: "reading" as const }]
          .slice(0, cur.depth.maxSources);
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
        if (sid) void interruptPi(sid);
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
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    set({ settings });
  }

  // Add a file that an agent created/touched but Mesa hasn't scanned yet, so
  // it appears in the sidebar and, if markdown, the graph. Other files (images,
  // PDFs, text, etc.) appear in the sidebar but don't get note metadata.
  async function registerExternalFile(rel: string): Promise<void> {
    const root = get().vaultPath;
    if (!root || get().fileFor(rel)) return;
    // One definition of what belongs in a vault, shared with scanVault's walk.
    if (!isIndexableVaultRelPath(rel)) return;
    const base = rel.replace(/.*\//, "");
    const ext = extOf(base);
    const isMarkdown = /^(md|markdown)$/i.test(ext);
    const path = `${root.replace(/\/+$/, "")}/${rel}`;
    const name = stripExt(base);
    const file: VaultFile = { path, relPath: rel, name, ext, isMarkdown };
    if (isMarkdown) {
      let content = "";
      try {
        content = await readNote(file);
      } catch {
        /* may not exist on disk yet (create announced before write) */
      }
      if (get().fileFor(rel)) return; // lost a race — already added
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
        contentCache: { ...get().contentCache, [rel]: content },
      });
    } else {
      // Non-markdown file — add to the file list so the sidebar shows it, but
      // no note metadata is needed (only markdown becomes a graph node).
      // Best-effort stat for sort ordering.
      try {
        const s = await stat(path);
        file.size = s.size;
        file.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
      } catch {
        /* stat unavailable — name-based sorting still works */
      }
      if (get().fileFor(rel)) return; // lost a race
      set({
        files: [...get().files, file].sort((a, b) =>
          a.relPath.localeCompare(b.relPath)
        ),
      });
    }
  }

  async function refreshMissingExternalFiles(root: string): Promise<void> {
    const current = get();
    if (!root || current.vaultPath !== root) return;
    const scanned = await scanVault(root);
    const existing = new Set(current.files.map((f) => f.relPath));
    const additions = scanned.filter((f) => !existing.has(f.relPath));
    if (additions.length === 0) return;

    const nextFiles = [...current.files, ...additions].sort((a, b) =>
      a.relPath.localeCompare(b.relPath)
    );
    const nextNotes = { ...current.notes };
    const nextCache = { ...current.contentCache };
    await Promise.all(
      additions
        .filter((f) => f.isMarkdown)
        .map(async (f) => {
          const text = await readNote(f);
          nextCache[f.relPath] = text;
          nextNotes[f.relPath] = {
            relPath: f.relPath,
            title: f.name,
            rawLinks: extractLinks(text),
            tags: extractTags(text),
            aliases: extractAliases(text),
            firstImagePath: undefined,
          };
        })
    );
    set({
      files: nextFiles,
      notes: nextNotes,
      contentCache: nextCache,
    });
  }

  function scheduleExternalRefresh(root: string): void {
    if (!root) return;
    if (externalRefreshTimer) clearTimeout(externalRefreshTimer);
    externalRefreshTimer = setTimeout(() => {
      externalRefreshTimer = undefined;
      void refreshMissingExternalFiles(root);
    }, 180);
  }

  // Remove a file from all relevant state maps when it's deleted externally.
  function removeExternalFile(rel: string): void {
    const files = get().files.filter((f) => f.relPath !== rel);
    const notes = { ...get().notes };
    delete notes[rel];
    const contentCache = { ...get().contentCache };
    delete contentCache[rel];
    const openTabs = get().openTabs.filter((t) => t !== rel);
    let activePath = get().activePath;
    if (activePath === rel) activePath = null;
    set({ files, notes, contentCache, openTabs, activePath });
  }

  // React to external file changes (AI agents / other tools editing the vault):
  // flicker the changed node and refresh its metadata so the graph stays live.
  // Handles creates, modifies, and deletes for ALL file types — not just
  // markdown — so the sidebar, graph, and content cache stay in sync with the
  // filesystem.
  async function handleExternalChange(events: VaultWatchEvent[]) {
    const rootRaw = get().vaultPath;
    if (!rootRaw) return;
    const active = get().activePath;
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
      await refreshMissingExternalFiles(rootRaw);
    };
    const flush = () => {
      if (!pendingContent.size && !pendingNotes.size && !filesDirty) return;
      const next: Partial<AppState> = {};
      if (pendingContent.size) {
        // Read at flush time, so creates and deletes that committed during the
        // loop are already in the base. `seen` means a rel is never both queued
        // here and removed in the same batch.
        const cache = { ...get().contentCache };
        for (const [rel, text] of pendingContent) cache[rel] = text;
        next.contentCache = cache;
      }
      if (pendingNotes.size) {
        const notes = { ...get().notes };
        for (const [rel, meta] of pendingNotes) notes[rel] = meta;
        next.notes = notes;
      }
      // Stat refreshes mutate the VaultFile objects in place; the array copy
      // exists only to give React a new identity to re-render from.
      if (filesDirty) next.files = [...get().files];
      set(next);
    };
    try {
      for (const evt of events) {
        for (const p of evt.paths) {
          // Cheap form first: a path under the vault root resolves on the
          // root-prefix branch without the list being read at all.
          let rel = normalizeVaultRelPath(p, rootRaw);
          if (!rel) rel = normalizeVaultRelPath(p, rootRaw, knownRels());
          if (!rel) {
            await rescanOnce();
            rel = normalizeVaultRelPath(p, rootRaw, knownRels());
            // Created after this batch's rescan: let the debounced refresh find
            // it instead of scanning the whole vault again mid-loop. Previously
            // such a path was simply dropped.
            if (!rel) scheduleExternalRefresh(rootRaw);
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
            if (get().fileFor(rel)) {
              removeExternalFile(rel);
            }
            continue;
          }

          // --- Create or Modify ---
          let file = get().fileFor(rel);
          if (!file) {
            // a brand-new file appeared on disk — register it
            await registerExternalFile(rel);
            file = get().fileFor(rel);
            if (!file) {
              await rescanOnce();
              file = get().fileFor(rel);
            }
            scheduleExternalRefresh(rootRaw);
            if (file) {
              let detail = "";
              let added = 0;
              if (file.isMarkdown) {
                const text = await readNote(file);
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
          if (file.isMarkdown) {
            const text = await readNote(file);
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
            // refresh everything except the doc currently being typed in-app
            if (rel !== active) {
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
            // Non-markdown file was modified (e.g. an image was replaced).
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
              rel !== active &&
              needsCachedTextRefresh(file, get().contentCache[rel])
            ) {
              const text = await readNote(file);
              // Mesa's own saves land here too; an unchanged read must not churn
              // the cache identity that every text consumer subscribes to.
              if (text !== get().contentCache[rel]) {
                pendingContent.set(rel, text);
              }
            }
            try {
              const s = await stat(file.path);
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
    try {
      unwatch?.();
    } catch {
      /* ignore */
    }
    unwatch = undefined;
    unwatch = await watchVault(root, (events) => void handleExternalChange(events));
  }

  // External agents (or any tool) report file access by POSTing to the Rust
  // server's /activity route, which re-emits an "activity" Tauri event. This is
  // how *reads* light up — filesystem watchers can't see reads. Set up once.
  let activityBridgeReady = false;
  async function setupActivityBridge() {
    if (activityBridgeReady || !IN_TAURI) return;
    activityBridgeReady = true;
    try {
      await listen<string>("activity", async (ev) => {
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
          // ensure the live card has content to peek (reads don't change it)
          void get().ensureContent(rel);
        } catch {
          /* ignore malformed activity payloads */
        }
      });
      // Pi's `browse` tool mirrors its navigation here (via the loopback
      // server) so the harness shows what the agent is reading.
      await listen<string>("mesa://browse", (ev) => {
        const url = String(ev.payload ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return;
        set((s) => ({ piBrowse: { url, seq: (s.piBrowse?.seq ?? 0) + 1 } }));
      });
    } catch {
      /* @tauri-apps/api/event unavailable */
    }
  }

  // --- sync console bridge -------------------------------------------------
  // The Rust engine emits structured `sync://log` + `sync://progress` events
  // during `sync_run` AND while the embedded server handles an incoming sync
  // (`[serve]` lines); collect them into the store so SyncModal's embedded
  // console renders both directions. Registered once at vault open (so a
  // receiving device misses nothing) and re-ensured before every local sync.
  let syncBridgeReady: Promise<void> | null = null;
  function ensureSyncEventBridge(): Promise<void> {
    if (!IN_TAURI) return Promise.resolve();
    if (!syncBridgeReady) {
      syncBridgeReady = (async () => {
        await listen<SyncLogEntry>(SYNC_LOG_EVENT, (ev) => {
          appendSyncLog(ev.payload);
        });
        await listen<SyncProgress>(SYNC_PROGRESS_EVENT, (ev) => {
          set({ syncProgress: ev.payload });
        });
      })().catch(() => {
        syncBridgeReady = null; // retry on the next sync
      });
    }
    return syncBridgeReady ?? Promise.resolve();
  }

  function appendSyncLog(entry: SyncLogEntry) {
    const cur = get().syncLog;
    const next = cur.length >= 1000 ? [...cur.slice(-999), entry] : [...cur, entry];
    set({ syncLog: next });
  }

  /** Client-side console line — for milestones the Rust engine can't see
   *  (e.g. the invoke itself rejecting before the engine starts). */
  function logSyncLocal(level: SyncLogEntry["level"], msg: string) {
    appendSyncLog({ ts: Date.now(), level, msg });
  }

  function syncStatusLine(name: string, r: SyncReport): string {
    const failed = r.failed.filter((f) => f.error !== "cancelled").length;
    let msg = `Synced with ${name} — ↓${r.pulled} ↑${r.pushed}`;
    if (r.conflicts) {
      msg += ` · ${r.conflicts} conflict cop${r.conflicts > 1 ? "ies" : "y"}`;
    }
    if (failed) msg += ` · ${failed} failed (see sync console)`;
    if (r.cancelled) msg += " · cancelled";
    return msg;
  }

  // Append a freshly created note into all the relevant maps.
  function addNote(file: VaultFile, content: string) {
    bumpActivityAmount(file.relPath, 1.3, "create");
    set({
      files: [...get().files, file].sort((a, b) =>
        a.relPath.localeCompare(b.relPath)
      ),
      notes: {
        ...get().notes,
        [file.relPath]: {
          relPath: file.relPath,
          title: file.name,
          rawLinks: extractLinks(content),
          tags: extractTags(content),
          aliases: extractAliases(content),
          firstImagePath: undefined,
        },
      },
      contentCache: { ...get().contentCache, [file.relPath]: content },
    });
  }

  return {
    vaultPath: null,
    vaultName: "",
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
    theme: initialTheme(),
    settings: initialSettings(),
    paletteOpen: false,
    searchOpen: false,
    searchSeed: "",
    settingsOpen: false,
    popoutDoc: null,
    revealTick: 0,
    syncOpen: false,
    syncListening: false,
    syncBusy: false,
    syncStatus: "",
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
    deepResearchOpenToken: 0,
    agentOpen: false,
    hoverPreview: null,
    dragView: null,
    draggingFile: null,
    dragGhost: null,
    keyboardFocus: { region: "center", rightIndex: 0 },
    collapsedFolders: {},
    emptyFolders: [],
    unindexedTextFiles: 0,

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
        void stopSyncServer().catch(() => {});
        set({ syncListening: false, syncBusy: false, syncStatus: "Sync disabled." });
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
    setSearch: (open) => set({ searchOpen: open }),
    setSearchSeed: (s) => set({ searchSeed: s }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setSyncOpen: (open) => set({ syncOpen: open }),

    revealActiveFile: () => set((s) => ({ revealTick: s.revealTick + 1 })),
    removeRecentVault: (path) => {
      const root = canonicalRoot(path);
      if (!root) return;
      const recents = forgetRecentVault(get().recentVaults, root);
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
        await startSyncServer(s.settings.syncPort, s.settings.syncToken, s.vaultPath);
        set({
          syncListening: true,
          syncStatus: `Listening on port ${s.settings.syncPort}. Add this device's pairing code, LAN IP, or Tailscale name on your other devices.`,
        });
      } catch (e) {
        set({ syncStatus: `Could not start server: ${String(e)}` });
      }
    },

    syncNow: async (peerId) => {
      const s = get();
      const peer = s.settings.peers.find((p) => p.id === peerId);
      if (!s.vaultPath || !peer) return;
      if (!s.settings.syncEnabled) {
        set({ syncStatus: "Sync is disabled." });
        return;
      }
      const token = peer.token || s.settings.syncToken;
      if (!token) {
        set({ syncStatus: "Set the sync key first." });
        return;
      }
      // Subscribe to the engine's log/progress events BEFORE starting so the
      // console never misses a line.
      await ensureSyncEventBridge();
      set({
        syncBusy: true,
        syncStatus: `Syncing with ${peer.name}…`,
        syncLastPeerId: peer.id,
        syncProgress: null,
      });
      logSyncLocal("info", `requested sync with ${peer.name} (${peer.address})`);
      try {
        // The entire sync runs natively (manifests, diff, transfers) — see
        // sync_run in src-tauri/src/sync.rs. Per-file failures come back in
        // the report instead of aborting the rest of the vault.
        const r = await syncWithPeer(
          s.vaultPath,
          peer.address,
          token,
          peer.fingerprint ?? null
        );
        const failed = r.failed.filter((f) => f.error !== "cancelled");
        get().updatePeer(peer.id, {
          lastSync: Date.now(),
          lastChecked: Date.now(),
          lastStatus: failed.length > 0 ? "error" : "ok",
          lastError:
            failed.length > 0
              ? `${failed.length} file${failed.length === 1 ? "" : "s"} failed — see the sync console`
              : undefined,
          // Trust-on-first-use: remember the fingerprint so future syncs pin it.
          fingerprint: peer.fingerprint || r.fingerprint || undefined,
        });
        // Re-scan only when files actually landed locally.
        if (r.pulled > 0 || r.conflicts > 0) {
          const prevActive = s.activePath;
          await get().openVault(s.vaultPath);
          if (prevActive && get().fileFor(prevActive)) {
            await get().selectFile(prevActive);
          }
        }
        set({
          syncBusy: false,
          syncReport: r,
          syncStatus: syncStatusLine(peer.name, r),
        });
      } catch (e) {
        const message = String(e);
        logSyncLocal("error", `sync with ${peer.name} failed: ${message}`);
        get().updatePeer(peer.id, {
          lastChecked: Date.now(),
          lastStatus: "error",
          lastError: message,
        });
        set({ syncBusy: false, syncReport: null, syncStatus: `Sync failed: ${message}` });
      }
    },
    syncAll: async () => {
      if (!get().settings.syncEnabled) {
        set({ syncStatus: "Sync is disabled." });
        return;
      }
      const peers = get().settings.peers;
      for (const p of peers) {
        await get().syncNow(p.id); // per-peer errors are caught inside
      }
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
          new WebviewWindow(label, {
            url,
            title: get().notes[relPath]?.title ?? relPath,
            width: 760,
            height: 860,
            resizable: true,
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

    openVault: async (path) => {
      const picked = path ?? (await pickVault());
      if (!picked) return;
      // Canonicalize here so *every* entry point (startup restore, ?vault=
      // deeplink, recent-row click, zip import, agent panel) stores the exact
      // same spelling as the folder dialog. Otherwise the recents list can hold
      // two forms of one folder and the switcher can't remove it (Windows).
      const root = picked === DEMO_ROOT ? DEMO_ROOT : canonicalRoot(picked);
      if (!root) return;
      set({ loading: true, status: "Scanning vault…" });
      // The task memo keys on relPath, so without this the outgoing vault's
      // note contents stay reachable until the dashboard next runs a pass.
      resetVaultTaskMemo();
      // Same reason: the search eligibility memo keys on relPath and holds the
      // text it answered for, so the outgoing vault's strings would stay
      // reachable through it.
      resetSearchEligibility();

      // Crash recovery first, so a file restored from a stale save backup is
      // scanned like any other. Never throws; never blocks opening the vault.
      const recovered = await recoverWriteArtifacts(root);
      if (recovered.restored.length) {
        console.warn(
          "[mesa] restored files from interrupted saves:",
          recovered.restored
        );
      }
      const files = await scanVault(root);
      // read note contents in parallel — far faster startup on large vaults
      const contents = new Map<string, string>();
      // Search reads the content cache for EVERY scanned file, so caching only
      // markdown left every other textual file (.txt/.html/.py/.json/…)
      // matchable by name alone — and inconsistently so, since opening one
      // cached it lazily and changed later results. `planTextCache` budgets
      // those extra reads from the scan's own size metadata; `searchMatch.ts`
      // is what keeps scanning the larger corpus cheap.
      const textPlan = planTextCache(files, isTextualVaultFile);
      await Promise.all(
        files
          .filter((f) => f.isMarkdown)
          .concat(textPlan.extra)
          .map(async (f) => {
            contents.set(f.relPath, await readNote(f));
          })
      );
      const notes = buildNotes(files, contents);
      const cache: Record<string, string> = {};
      contents.forEach((v, k) => (cache[k] = v));

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
      try {
        localStorage.setItem(LAST_VAULT_KEY, root);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
      } catch {
        /* ignore */
      }

      set({
        vaultPath: root,
        vaultName: name,
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
        loading: false,
        status: `${Object.keys(notes).length} notes`,
      });

      const first = files.find((f) => f.isMarkdown);
      if (first) await get().selectFile(first.relPath);

      void setupWatcher(root);
      void setupActivityBridge();
      // Register the sync log/progress listener now — not just before a local
      // sync — so INCOMING syncs (this device receiving; `[serve]` lines from
      // the Rust server) fill the console too. Without this, the receiving
      // device dropped every event and showed no console at all.
      void ensureSyncEventBridge();
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
      set({ activePath: relPath, content: cached ?? "", openTabs: tabs });
      if (textual && cached === undefined) {
        const text = await get().ensureContent(relPath);
        // Commit only if this file is still the active one, and prefer the
        // cache (it may contain edits made while the read was in flight).
        if (get().activePath === relPath) {
          set({ content: get().contentCache[relPath] ?? text });
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
      const id = resolveTarget(get().notes, target);
      if (id) {
        await get().selectFile(id);
        return;
      }
      const root = get().vaultPath;
      if (!root) return;
      const rel = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
      const content = `# ${target}\n\n`;
      const file = await createNote(root, rel, content);
      addNote(file, content);
      await get().selectFile(file.relPath);
    },

    setContentFromEditor: (text) => {
      const active = get().activePath;
      if (!active) return;
      const prev = get().contentCache[active] ?? "";
      set({
        content: text,
        contentCache: { ...get().contentCache, [active]: text },
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

      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const file = get().fileFor(active);
        // Same gate as flushSave: only a file the text pipeline owns is ever
        // written from editor text (`flushableNoteText`).
        const pending = file
          ? flushableNoteText(file, get().contentCache[active] ?? text)
          : null;
        if (file && pending !== null) {
          void writeNote(file, pending).catch((e) =>
            set({ status: `Save failed: ${String(e)}` })
          );
        }
        const cur = get().notes[active];
        // Replace the notes map only when the extracted metadata actually
        // changed: its identity churn drives the graph rebuild, the backlink
        // re-index, and every notes subscriber, and typing prose leaves
        // links/tags/aliases untouched on most saves.
        const next = cur ? refreshedNoteMeta(cur, text) : null;
        if (next) set({ notes: { ...get().notes, [active]: next } });
      }, 500);
    },

    // Write the active note to disk immediately (on blur / hide / quit) so a
    // debounced edit is never lost to a crash or close.
    //
    // This runs for whatever file happens to be ACTIVE, on events the user
    // never thinks of as saving (window blur, hide, quit), so what it may
    // write is decided by `flushableNoteText`: never a file the text pipeline
    // does not own (a PDF/image/binary would be replaced by zero bytes — it
    // has no cached text by design), and never a file whose text Mesa has not
    // actually loaded yet (a note whose opening read is still in flight).
    flushSave: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      const active = get().activePath;
      if (!active) return;
      const file = get().fileFor(active);
      if (!file) return;
      const pending = flushableNoteText(file, get().contentCache[active]);
      if (pending === null) return;
      void writeNote(file, pending).catch((e) =>
        set({ status: `Save failed: ${String(e)}` })
      );
    },

    newNote: async () => {
      const root = get().vaultPath;
      if (!root) return;
      const existing = new Set(get().files.map((f) => f.relPath.toLowerCase()));
      let rel = "Untitled.md";
      let n = 1;
      while (existing.has(rel.toLowerCase())) rel = `Untitled ${n++}.md`;
      const content = `# ${rel.replace(/\.md$/, "")}\n\n`;
      const file = await createNote(root, rel, content);
      addNote(file, content);
      await get().selectFile(file.relPath);
    },

    // Right-click a folder → New note inside it.
    createChildNote: async (folderPath) => {
      const root = get().vaultPath;
      if (!root) return;
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
    },

    // Right-click a folder → New folder inside it. Empty folders aren't returned
    // by disk scans, so we track them in session state until they hold a file.
    createChildFolder: async (folderPath) => {
      const root = get().vaultPath;
      if (!root) return;
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
    },

    // Duplicate any file (note or asset) next to itself with a " copy" name.
    duplicateEntry: async (relPath) => {
      const root = get().vaultPath;
      const file = get().fileFor(relPath);
      if (!root || !file) return;
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
          contentCache: { ...get().contentCache, [newFile.relPath]: text },
        });
        await get().selectFile(newFile.relPath);
      } else {
        set({
          files: [...get().files, newFile].sort((a, b) =>
            a.relPath.localeCompare(b.relPath)
          ),
        });
      }
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

    openDeepResearch: (openOverlay = true) => {
      // Opening a surface never resets an in-flight run — it only ensures the
      // run object exists so both launchers read/drive the same state, then
      // optionally bumps the open-token so the Steam overlay opens + focuses
      // its window. Pi's launcher passes false and owns its slide-out wing.
      const cur = get().deepResearch;
      if (!cur) {
        set({
          deepResearch: {
            runId: createRunId(),
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
        set((s) => ({
          deepResearchOpenToken: s.deepResearchOpenToken + 1,
          overlayOpen: true,
          piOverlayOpen: false,
        }));
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
      const context = buildResearchContext({
        query: trimmed,
        activePath: get().activePath,
        selectedPaths: opts?.selectedPaths ?? [],
        files: get().files,
        notes: get().notes,
        content: get().contentCache,
        limits,
        scope,
      });

      const runId = createRunId();
      drSeq += 1;
      set({
        deepResearch: {
          runId,
          query: trimmed,
          phase: "planning",
          launchStage: "preparing",
          startedAt: Date.now(),
          promptBytes: 0,
          promptSentAt: null,
          firstSignalAt: null,
          depth,
          context,
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
        set({ agentOpen: true });
      } else if (!currentPiSessionId()) {
        drPatch({ launchStage: "starting-pi" });
      }
      if (currentPiSessionId()) {
        drPatch({ launchStage: "restarting-pi" });
        await requestSharedPiRestart();
      }
      let sessionId: string | null = null;
      for (let i = 0; i < 40 && !sessionId; i++) {
        await new Promise((r) => setTimeout(r, 150));
        sessionId = currentPiSessionId();
        if (get().deepResearch?.runId !== runId) return; // superseded/cancelled
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
      drPatch({ launchStage: "bridge-ready" });
      try {
        await drStartListening(runId);
      } catch (e) {
        drPatch({ phase: "error", launchStage: "error", error: `Could not start the Deep Research progress bridge: ${String(e)}` });
        if (currentPiSessionId()) await requestSharedPiRestart();
        return;
      }

      const prompt = buildResearchPrompt({
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
        await sendResearchPrompt(sessionId, prompt);
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
      const sid = currentPiSessionId();
      if (sid) await interruptPi(sid);
      await drStopListening();
      drPatch({ phase: "cancelled", launchStage: "cancelled", error: null, changeSet: null });
      if (sid) await requestSharedPiRestart();
    },

    applyDeepResearch: async () => {
      const cur = get().deepResearch;
      if (!cur || !cur.changeSet) return;
      const root = get().vaultPath;
      if (!root) {
        drPatch({ phase: "error", launchStage: "error", error: "The vault is no longer open." });
        return;
      }
      // Version-check the change set against the CURRENT vault before writing.
      const plan = resolveApplyPlan({
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
      const outcome = await applyChangeSet({ root, plan });
      if (!outcome.ok) {
        drPatch({ phase: "error", launchStage: "error", error: outcome.error ?? "Apply failed.", changeSet: null });
        return;
      }
      drPatch({ phase: "done", launchStage: "done", appliedRelPaths: outcome.appliedRelPaths });
      // Refresh the vault scan, content cache, backlinks, and graph so the new
      // notes and links appear (and the graph lights up) immediately.
      if (root) await refreshMissingExternalFiles(root);
      const latest = get();
      const notes = { ...latest.notes };
      const contentCache = { ...latest.contentCache };
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
      if (get().fileFor(reportRel)) await get().openFile(reportRel);
    },

    discardDeepResearch: () => {
      void drStopListening();
      set({ deepResearch: null });
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
      const file = await createNote(root, rel, body);
      addNote(file, body);
      await get().selectFile(rel);
    },

    // Calendar events persist in calendar.json at the vault root.
    addCalendarEvent: async (date, title) => {
      const root = get().vaultPath;
      const t = title.trim();
      if (!root || !date || !t) return;
      const events = [...get().calendarEvents, { date, title: t }];
      const content = serializeEvents(events);
      const existing = get().fileFor(CALENDAR_FILE);
      if (existing) {
        await writeNote(existing, content);
      } else {
        const file = await createNote(root, CALENDAR_FILE, content);
        set({
          files: [...get().files, file].sort((a, b) =>
            a.relPath.localeCompare(b.relPath)
          ),
        });
      }
      set({
        calendarEvents: events,
        contentCache: { ...get().contentCache, [CALENDAR_FILE]: content },
      });
    },
    removeCalendarEvent: async (date, title) => {
      if (!get().vaultPath) return;
      const events = get().calendarEvents.filter(
        (e) => !(e.date === date && e.title === title)
      );
      const content = serializeEvents(events);
      const existing = get().fileFor(CALENDAR_FILE);
      if (existing) await writeNote(existing, content);
      set({
        calendarEvents: events,
        contentCache: { ...get().contentCache, [CALENDAR_FILE]: content },
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
      const existing = get().fileFor(rel);
      if (existing) {
        const cur = await get().ensureContent(rel);
        const next = cur.replace(/\s*$/, "") + "\n" + line + "\n";
        await writeNote(existing, next);
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
        set({ notes, contentCache: { ...get().contentCache, [rel]: next } });
      } else {
        const content = `# Tasks\n\n${line}\n`;
        const file = await createNote(root, rel, content);
        addNote(file, content);
      }
    },

    updateTask: async (relPath, line, patch) => {
      const file = get().fileFor(relPath);
      if (!file) return;
      const prev = await get().ensureContent(relPath);
      const next = updateTaskLine(prev, line, patch);
      if (next === prev) return;
      set({
        content: get().activePath === relPath ? next : get().content,
        contentCache: { ...get().contentCache, [relPath]: next },
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
      void writeNote(file, next);
    },

    importDropped: async (paths) => {
      const root = get().vaultPath;
      if (!root) return;
      set({ status: "Importing…" });
      const created = await importDroppedPaths(root, paths);
      if (created.length === 0) {
        set({ status: `${Object.keys(get().notes).length} notes` });
        return;
      }
      const files = [...get().files];
      const notes = { ...get().notes };
      const contentCache = { ...get().contentCache };
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
        status: `Imported ${created.length} file${created.length > 1 ? "s" : ""}`,
      });
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
          return;
        }
      }
      const firstMd = created.find((f) => f.isMarkdown);
      if (firstMd) await get().selectFile(firstMd.relPath);
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
      if (file) await removeFile(file.path);
      else await removeVaultEntry(root, relPath, true);
      const removed = new Set(matches.map((f) => f.relPath));
      if (file) removed.add(relPath);
      const files = get().files.filter((f) => !removed.has(f.relPath));
      const notes = { ...get().notes };
      for (const rel of removed) delete notes[rel];
      const contentCache = { ...get().contentCache };
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
        status: `Deleted ${isFolder ? "folder" : "file"} ${relPath}`,
      });
      if (active && contentCache[active] === undefined) void get().selectFile(active);
    },

    renameNote: async (relPath, newBaseName) => {
      const file = get().fileFor(relPath);
      const root = get().vaultPath;
      if (!file || !root) return;
      const clean = safeBaseName(newBaseName.replace(/\.md$/i, ""));
      if (!clean) return;
      const dir = relPath.includes("/")
        ? relPath.slice(0, relPath.lastIndexOf("/") + 1)
        : "";
      const newRel = `${dir}${clean}.md`;
      if (newRel === relPath || get().fileFor(newRel)) return;
      const content = await get().ensureContent(relPath);
      const newFile = await createNote(root, newRel, content);
      await removeFile(file.path);

      const meta = get().notes[relPath];
      const files = get()
        .files.filter((f) => f.relPath !== relPath)
        .concat(newFile)
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
      const notes = { ...get().notes };
      delete notes[relPath];
      notes[newRel] = {
        relPath: newRel,
        title: newFile.name,
        rawLinks: meta?.rawLinks ?? extractLinks(content),
        tags: meta?.tags ?? extractTags(content),
        aliases: meta?.aliases ?? extractAliases(content),
        firstImagePath: meta?.firstImagePath,
      };
      const contentCache = { ...get().contentCache };
      contentCache[newRel] = content;
      delete contentCache[relPath];
      const openTabs = get().openTabs.map((t) => (t === relPath ? newRel : t));
      const activePath = get().activePath === relPath ? newRel : get().activePath;
      set({ files, notes, contentCache, openTabs, activePath });
    },

    closeTab: (relPath) => {
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

    togglePanel: (panel) => {
      const settings = get().settings;
      commitSettings({
        ...settings,
        ...toggleWorkspacePanel(settings.centerView, settings.rightStack, panel),
      });
    },
    removeViewFromWorkspace: (view) => {
      const settings = get().settings;
      commitSettings({
        ...settings,
        ...removeFromWorkspace(settings.centerView, settings.rightStack, view),
      });
    },
    dropViewInCenter: () => {
      const d = get().dragView;
      if (!d) return;
      const settings = get().settings;
      commitSettings({
        ...settings,
        ...placeInCenter(settings.centerView, settings.rightStack, d.view),
      });
      set({ dragView: null });
    },
    dropViewAt: (index) => {
      const d = get().dragView;
      if (!d) return;
      const settings = get().settings;
      commitSettings({
        ...settings,
        ...placeInRight(settings.centerView, settings.rightStack, d.view, index),
      });
      set({ dragView: null });
    },
    closeCenter: () => {
      const settings = get().settings;
      commitSettings({
        ...settings,
        ...closeCenterView(settings.centerView, settings.rightStack),
      });
    },
    moveViewToCenter: (view) => {
      const settings = get().settings;
      commitSettings({
        ...settings,
        ...placeInCenter(settings.centerView, settings.rightStack, view),
      });
    },
    moveViewToRight: (view, index) => {
      const settings = get().settings;
      if (index === undefined) {
        commitSettings({
          ...settings,
          ...openViewInWorkspace(settings.centerView, settings.rightStack, view),
        });
        return;
      }
      commitSettings({
        ...settings,
        ...placeInRight(
          settings.centerView,
          settings.rightStack,
          view,
          index ?? settings.rightStack.length
        ),
      });
    },
    flipDockSide: () => {
      const settings = get().settings;
      if (settings.rightStack.length === 0) return;
      get().setSetting(
        "dockSide",
        settings.dockSide === "right" ? "left" : "right"
      );
    },
    toggleGraphFull: () => set({ graphFull: !get().graphFull }),

    openPanelWindow: async (panel, placement) => {
      if (!IN_TAURI) return;
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const vault = get().vaultPath ?? "";
        const theme = get().theme;
        const label = `panel-${panel}-${Date.now().toString(36)}`;
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
        new WebviewWindow(label, {
          url,
          title: panel[0].toUpperCase() + panel.slice(1),
          width: Math.max(360, placement?.width ?? 720),
          height: Math.max(280, placement?.height ?? 820),
          ...(placement ? { x: placement.x, y: placement.y } : {}),
          resizable: true,
        });
      } catch {
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
      }
    },

    ensureContent: async (relPath) => {
      const cached = get().contentCache[relPath];
      if (cached !== undefined) return cached;
      const pending = pendingContentReads.get(relPath);
      if (pending) return pending;
      const file = get().fileFor(relPath);
      if (!file) return "";
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
          if (current?.path === file.path) {
            set({ contentCache: { ...get().contentCache, [relPath]: text } });
          }
          return text;
        })
        .finally(() => {
          pendingContentReads.delete(relPath);
        });
      pendingContentReads.set(relPath, read);
      return read;
    },

    ensurePeek: async (relPath) => {
      const full = get().contentCache[relPath];
      if (full !== undefined) return full;
      const now = Date.now();
      const hit = peekCache.get(relPath);
      if (hit && now - hit.at < PEEK_TTL_MS) return hit.text;
      const pending = pendingPeekReads.get(relPath);
      if (pending) return pending;
      const file = get().fileFor(relPath);
      if (!file) return "";
      const read = peekNote(file)
        .then((text) => {
          peekCache.set(relPath, { text, at: Date.now() });
          // Tiny LRU-ish cap: drop the oldest insertion once past the cap.
          if (peekCache.size > PEEK_CACHE_MAX) {
            const oldest = peekCache.keys().next().value;
            if (oldest !== undefined) peekCache.delete(oldest);
          }
          return text;
        })
        .finally(() => {
          pendingPeekReads.delete(relPath);
        });
      pendingPeekReads.set(relPath, read);
      return read;
    },

    fileFor: (relPath) => fileIndexFor(get().files).get(relPath),
  };
});

/** Convenience for non-react callers. */
export function getStore() {
  return useAppStore.getState();
}
