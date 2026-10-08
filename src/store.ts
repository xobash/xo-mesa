import { create } from "zustand";
import { createDocumentController } from "./controllers/documents";
import { createPersistenceController } from "./controllers/persistence";
import { createResearchController } from "./controllers/research";
import { createVaultController } from "./controllers/vault";
import { createWorkspaceController } from "./controllers/workspace";
import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet,
  type ActivityOp,
} from "./lib/activity";
import {
  applyTemplate,
  localISO,
  localTime,
  serializeEvents,
  type CalEvent
} from "./lib/daily";
import { forkContentCache } from "./lib/documentWorkingSet";
import { ancestorFolders, childRelPath, duplicateRelPath, safeBaseName } from "./lib/fsnames";
import { makeResolver } from "./lib/graph";
import type { KeyboardFocus } from "./lib/keyboardNav";
import { extractAliases, extractLinks, extractLinksAndFirstImage, extractTags } from "./lib/markdownExtract";
import { normalizeSyncPort, parsePeerInput } from "./lib/pairing";
import { validSyncKey } from "./lib/syncKey";
import {
  type PaneDrag
} from "./lib/panes";
import { loadSettings, persistSettings, scrubStoredSyncSecrets } from "./lib/settings";
import { hydrateSyncSecrets, persistSyncSecrets, syncSecretSignature } from "./lib/syncSecrets";
import {
  type SyncLogEntry,
  type SyncProgress,
  type SyncReport,
} from "./lib/sync";
import { conflictBackupPath, reviewedConflictPath } from "./lib/syncConflicts";
import { createSyncWorkflow } from "./lib/syncWorkflow";
import {
  migrateTextRevisionsAsync,
  type TextRevision
} from "./lib/textRevisionHistory";
import {
  IN_TAURI, authorizeVaultRoot, canonicalRoot, copyVaultFile, createFolder, createNote, importDroppedPaths, isTextualVaultFile, normalizeVaultRelPath, pickVault, readNote,
  readNoteResult, readReviewText, removeFile,
  removeVaultEntry, renameVaultFile, writeNote, writeVaultBinaryFile, writeVaultTextFile, type RecoveryEntry
} from "./lib/vault";
import { forgetVaultIndex } from "./lib/vaultIndex";
import type {
  NoteMeta,
  PaneView,
  PreviewTarget,
  RightPanel,
  Settings,
  SyncPeer,
  VaultFile,
  WorkspacePreset
} from "./types";

import { listen } from "@tauri-apps/api/event";
import type {
  DeepResearchContext,
  DeepResearchLaunchStage,
  DeepResearchPhase,
  DeepResearchResult,
  ResearchActivity,
  ResearchChangeSet,
  ResearchContextScope,
  ResearchDepth,
} from "./lib/deepResearch";
import { createFileIndex } from "./lib/fileIndex";
import { normalizeRelativeTarget, referenceMayTarget, rewriteInboundLinks } from "./lib/linkRewrite";
import {
  LAST_VAULT_KEY,
  RECENTS_KEY,
  THEME_KEY,
  initialRecents,
  initialTheme,
  type ThemeId
} from "./lib/persistedUi";
import { forgetRecentVault } from "./lib/recentVaults";
import { createSyncEventBridge } from "./lib/syncEventBridge";
import {
  updateTaskLine,
  type TaskLinePatch
} from "./lib/tasks";
import {
  type TextSaveHold
} from "./lib/textSaveCoordinator";
import type { DetachedWindowPlacement } from "./lib/windowTearOff";
export type { ThemeId } from "./lib/persistedUi";

const CALENDAR_FILE = "calendar.json";
let activeImportAbort: AbortController | null = null;

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

export const THEMES: { id: ThemeId; label: string; blurb: string }[] = [
  { id: "system", label: "System", blurb: "Neutral, follows OS light/dark" },
  { id: "void", label: "Void", blurb: "Violet pulse on black" },
  { id: "darkroom", label: "Darkroom", blurb: "Cinematic monochrome" },
];

/** Sidebar sort modes whose order depends on `size`/`mtime`, so vault open has
 *  to wait for the per-file stat pass instead of deferring it. */

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
  activeContentState: "ready" | "loading" | "failed" | "size-limit";
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
  /** Monotonic request so Settings can focus the contextual recovery section. */
  revisionHistoryRequest: number;
  settingsSection: "settings" | "history" | "deleted";
  openRecovery: () => void;
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
   *  Deep Research surface — the Mesa overlay window and the Pi panel button
   *  both read and drive this one run, never separate state machines. */
  deepResearch: DeepResearchRunState | null;
  /** The one visible Deep Research host. Pi surfaces claim this with a stable
   *  per-mount id; overlay/native hosts use a named id. Run state is shared,
   *  presentation ownership is exclusive. */
  deepResearchSurface: string | null;
  /** Tell the Mesa overlay to open/focus a specific floating window, with
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
  skippedTextFiles: number;
  failedTextFiles: number;
  unreadableTextReasons: Record<string, "skipped" | "failed">;
    /** Text files still awaiting background indexing after vault open.
   * Non-zero means search and other indexed views have incomplete coverage. */
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
   *  Mesa overlay dock and the Pi panel button) call this one opener so they
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
  loadSyncSecrets: () => Promise<void>;
  setPalette: (open: boolean) => void;
  openSearch: (seed?: string) => void;
  setSearch: (open: boolean) => void;
  setSearchSeed: (s: string) => void;
  setSettingsOpen: (open: boolean) => void;
  openRevisionHistory: () => void;
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
  removePeer: (id: string) => Promise<void>;
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
  loadActiveContent: () => Promise<void>;
  openFile: (relPath: string) => Promise<void>;
  openTarget: (target: string) => Promise<void>;
  setContentFromEditor: (text: string, activity?: { snippet: string; lines: { added: number; removed: number }; tasksUnchanged?: boolean }) => void;
  flushSave: () => Promise<void>;
  retryTextSaveIssue: (key: string) => Promise<void>;
  useDiskTextForSaveIssue: (key: string) => Promise<void>;
  listActiveTextRevisions: () => Promise<TextRevision[]>;
  restoreTextRevision: (revisionId: string) => Promise<void>;
  purgeTextRevision: (revisionId: string) => Promise<void>;
  restoreRecoveryEntry: (entry: RecoveryEntry) => Promise<VaultFile>;
  newNote: () => Promise<void>;
  createChildNote: (folderPath: string) => Promise<void>;
  getVaultGeneration: () => number;
  /** Save an editable overlay document against its loaded disk baseline. */
  saveOverlayArtifact: (
    kind: "scratchpad" | "whiteboard",
    content: string | Uint8Array,
    date?: string,
    binding?: { root: string; generation: number; expected: string | null }
  ) => Promise<string | null>;
  createChildFolder: (folderPath: string) => Promise<void>;
  duplicateEntry: (relPath: string) => Promise<void>;
  toggleBookmark: (relPath: string) => void;
  importDropped: (paths: string[]) => Promise<void>;
  /** Cancels a queued or worker-backed drop import before the next file write. */
  cancelImport: () => void;
  importInProgress: boolean;
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
  applyWorkspacePreset: (preset: WorkspacePreset) => void;
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
  // Report failed vault mutations through status. Rebuild the file lookup
  // index only when the file list changes.
  const fileIndexFor = createFileIndex();
  let secretsLoad: Promise<void> | null = null;
  let secretsWriteTail: Promise<void> = Promise.resolve();
  let secretSaveError = "";
  const bootSettings = loadSettings();
  if (!IN_TAURI) {
    try { scrubStoredSyncSecrets(); } catch { /* Keep unreadable settings for recovery. */ }
  }

  function loadSyncSecrets(): Promise<void> {
    if (!IN_TAURI) return Promise.resolve();
    if (!secretsLoad) {
      secretsLoad = hydrateSyncSecrets(bootSettings.settings).then(hydrated => {
        const current = get().settings;
        const boot = bootSettings.settings;
        const bootPeers = new Map(boot.peers.map(peer => [peer.id, peer.token]));
        const hydratedPeers = new Map(hydrated.peers.map(peer => [peer.id, peer.token]));
        set({ settings: {
          ...current,
          syncToken: current.syncToken === boot.syncToken ? hydrated.syncToken : current.syncToken,
          peers: current.peers.map(peer => ({
            ...peer,
            token: peer.token === bootPeers.get(peer.id)
              ? hydratedPeers.get(peer.id)
              : peer.token,
          })),
        } });
      }).catch(error => {
        secretsLoad = null;
        secretSaveError = String(error);
        set({ settingsIssue: `Sync credentials could not be loaded from the OS credential store: ${String(error)}. Existing saved keys were preserved.` });
        throw error;
      });
    }
    return secretsLoad;
  }

  function commitSettings(settings: Settings): void {
    const secretChanged = syncSecretSignature(settings) !== syncSecretSignature(get().settings);
    const settingsIssue = persistSettings(settings);
    set({ settings, settingsIssue: secretSaveError
      ? `Sync credentials could not be saved in the OS credential store: ${secretSaveError}. Keep this window open and retry.`
      : settingsIssue });
    if (IN_TAURI && secretChanged) {
      secretsWriteTail = secretsWriteTail.then(async () => {
        await loadSyncSecrets();
        const submitted = get().settings;
        const secured = await persistSyncSecrets(submitted);
        const current = get().settings;
        set({ settings: { ...current,
          syncToken: current.syncToken === submitted.syncToken ? secured.syncToken : current.syncToken,
          peers: current.peers.map(peer => ({ ...peer, token: peer.token === submitted.peers.find(p => p.id === peer.id)?.token ? secured.peers.find(p => p.id === peer.id)?.token : peer.token })),
        } });
        secretSaveError = "";
      }).catch(error => {
        secretSaveError = String(error);
        set({ settingsIssue: `Sync credentials could not be saved in the OS credential store: ${String(error)}. Keep this window open and retry.` });
      });
    }
  }

  let listenerTail: Promise<void> = Promise.resolve();
  function queueListener<T>(work: () => Promise<T>): Promise<T> {
    const next = listenerTail.then(work, work);
    listenerTail = next.then(() => {}, () => {});
    return next;
  }
  async function stopListening(): Promise<boolean> {
    return queueListener(async () => {
      if (!get().syncListening) return false;
      const { stopSyncServer } = await import("./lib/sync");
      await stopSyncServer();
      set({ syncListening: false });
      return true;
    });
  }
  async function startListening(root: string): Promise<void> {
    await loadSyncSecrets();
    await secretsWriteTail;
    if (secretSaveError) throw new Error(`Sync key was not saved: ${secretSaveError}`);
    await queueListener(async () => {
      const s = get();
      if (s.vaultPath !== root || !s.settings.syncEnabled || !validSyncKey(s.settings.syncToken)) return;
      const { startSyncServer, retireSyncPeers } = await import("./lib/sync");
      await retireSyncPeers(root, s.settings.retiredSyncPeers ?? []);
      if (get().vaultPath !== root || !get().settings.syncEnabled) return;
      const current = get().settings;
      await startSyncServer(current.syncPort, current.syncToken, root, current.syncBindAddress);
      set({ syncListening: true, syncStatus: `Listening on port ${current.syncPort}.` });
    });
  }

  // Register reported file activity once; reads arrive through the activity bridge, not filesystem watchers.
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
            await vault.refreshMissingExternalFiles(rootRaw);
            rel = normalizeVaultRelPath(
              String(data.path ?? ""),
              rootRaw,
              get().files.map((f) => f.relPath)
            );
          }
          if (!rel) return;
          // an agent may reference a file we haven't scanned yet (e.g. one it
          // just created) — register it so it gets a node and can flicker.
          if (!get().fileFor(rel)) await vault.registerExternalFile(rel);
          if (!get().fileFor(rel)) {
            if (rootRaw) await vault.refreshMissingExternalFiles(rootRaw);
          }
          if (!get().fileFor(rel)) return; // still unknown (non-md / no vault)
          const amount = op === "read" ? 0.7 : op === "create" ? 1.3 : 1.0;
          bumpActivityAmount(rel, amount, op, status, detail, {
            added: Number.isFinite(added) ? added : 0,
            removed: Number.isFinite(removed) ? removed : 0,
          });
          if (op !== "read" && rootRaw) vault.scheduleExternalRefresh(rootRaw);
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

  // Collect incoming and outgoing sync logs/progress; register at vault open and ensure before local sync.
  const syncEvents = createSyncEventBridge({
    get: () => ({ syncLog: get().syncLog }),
    set: (patch) => set(patch),
  });
  const ensureSyncEventBridge = syncEvents.ensure;
  const logSyncLocal = syncEvents.log;

  // Compose workflow owners once. Peer callbacks are deferred until an action
  // runs, after every controller has been constructed.
  const persistence = createPersistenceController({
    get, set, getGeneration: () => vault.generation,
    refreshMissingExternalFiles: (...args) => vault.refreshMissingExternalFiles(...args),
  });
  const { textSaves, saveTextMutation, reportingFailure, clearTextSaveIssues } = persistence;
  const documents = createDocumentController({
    get, set, textSaves, commitSettings, reportingFailure,
    getGeneration: () => vault.generation,
  });
  const research = createResearchController({
    get, set, getGeneration: () => vault.generation,
    registerExternalFile: (...args) => vault.registerExternalFile(...args),
    refreshMissingExternalFiles: (...args) => vault.refreshMissingExternalFiles(...args),
  });
  const vault = createVaultController({
    get, set, textSaves, resetDocuments: documents.reset,
    stopResearch: research.stop, setupActivityBridge, ensureSyncEventBridge,
    stopListening, startListening,
  });
  const windows = createWorkspaceController({ get, set, commitSettings });
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
    activeContentState: "ready",
    graphFull: false,
    loading: false,
    status: "",
    importInProgress: false,
    textSaveIssues: {},
    textSaveState: { pending: 0, saving: 0, failed: 0 },
    theme: initialTheme(),
    settings: bootSettings.settings,
    settingsIssue: bootSettings.issue,
    loadSyncSecrets,
    retrySettings: () => {
      commitSettings(get().settings);
      if (IN_TAURI) {
        secretsWriteTail = secretsWriteTail.then(async () => {
          await loadSyncSecrets();
          const submitted = get().settings;
        const secured = await persistSyncSecrets(submitted);
        const current = get().settings;
        set({ settings: { ...current,
          syncToken: current.syncToken === submitted.syncToken ? secured.syncToken : current.syncToken,
          peers: current.peers.map(peer => ({ ...peer, token: peer.token === submitted.peers.find(p => p.id === peer.id)?.token ? secured.peers.find(p => p.id === peer.id)?.token : peer.token })),
        } });
          secretSaveError = "";
          set({ settingsIssue: "" });
        }).catch(error => {
          secretSaveError = String(error);
          set({ settingsIssue: `Sync credentials could not be saved in the OS credential store: ${String(error)}. Keep this window open and retry.` });
        });
      }
    },
    paletteOpen: false,
    searchOpen: false,
    searchSeed: "",
    settingsOpen: false,
    revisionHistoryRequest: 0,
    settingsSection: "settings",
    openRecovery: () => set({ settingsOpen: true, settingsSection: "deleted" }),
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
    skippedTextFiles: 0,
    failedTextFiles: 0,
    unreadableTextReasons: {},
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
        void stopListening().catch((error) => set({ syncStatus: `Could not stop server: ${String(error)}` }));
        void get().cancelCurrentSync();
        set({ syncStatus: "Sync disabled." });
      }
      if ((key === "syncToken" || key === "syncPort" || key === "syncBindAddress") && get().syncListening) {
        void queueListener(async () => {
          await secretsWriteTail;
          const current = get();
          if (!current.syncListening || !current.vaultPath || !current.settings.syncEnabled) return;
          if (secretSaveError) {
            const { stopSyncServer } = await import("./lib/sync");
            await stopSyncServer();
            set({ syncListening: false, syncStatus: `Receive stopped: sync key was not saved in the OS credential store.` });
            return;
          }
          if (!validSyncKey(current.settings.syncToken)) {
            const { stopSyncServer } = await import("./lib/sync");
            await stopSyncServer();
            set({ syncListening: false, syncStatus: "Receive stopped: generate a 64-character lowercase hex key." });
            return;
          }
          const { startSyncServer } = await import("./lib/sync");
          await startSyncServer(current.settings.syncPort, current.settings.syncToken, current.vaultPath, current.settings.syncBindAddress);
          set({ syncStatus: `Listening on port ${current.settings.syncPort}.` });
        }).catch((error) => set({ syncListening: false, syncStatus: `Could not restart server: ${String(error)}` }));
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
    setSettingsOpen: (open) => set({ settingsOpen: open, ...(open ? { settingsSection: "settings" as const } : {}) }),
    openRevisionHistory: () => set((state) => ({
      settingsOpen: true,
      revisionHistoryRequest: state.revisionHistoryRequest + 1,
      settingsSection: "history",
    })),
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
      commitSettings({
        ...get().settings, peers: [...peers, peer],
        retiredSyncPeers: get().settings.retiredSyncPeers?.filter(value => value !== fp)
      });
      return id;
    },
    updatePeer: (id, patch) => {
      get().setSetting(
        "peers",
        get().settings.peers.map((p) => (p.id === id ? { ...p, ...patch } : p))
      );
    },
    removePeer: async (id) => {
      const peer = get().settings.peers.find(peer => peer.id === id);
      if (!peer) return;
      await reportingFailure("Remove sync peer", async () => {
        if (get().syncBusy) throw new Error("Stop sync before removing a peer.");
        const root = get().vaultPath;
        if (root && peer.fingerprint) {
          const { retireSyncPeer } = await import("./lib/sync");
          await retireSyncPeer(root, peer.fingerprint);
        }
        commitSettings({
          ...get().settings, peers: get().settings.peers.filter(peer => peer.id !== id),
          retiredSyncPeers: [...new Set([...(get().settings.retiredSyncPeers ?? []), ...(peer.fingerprint ? [peer.fingerprint] : [])])]
        });
      });
    },

    receiveSharedVault: async ({ address, token, name, fingerprint }) => {
      // The caller has already confirmed the address + key reach a Mesa vault
      // and observed its certificate fingerprint. Let the user choose where it
      // lands, then clone into it.
      const root = await pickVault();
      if (!root) return null; // folder picker cancelled

      set({ loading: true, status: "Downloading shared vault…" });
      try {
        await loadSyncSecrets();
        await authorizeVaultRoot(root);
        // Two-way sync against the freshly chosen folder: an empty folder pulls
        // everything; a non-empty one merges safely (conflicts become copies).
        await ensureSyncEventBridge();
        const { syncWithPeer } = await import("./lib/sync");
        const result = await syncWithPeer(root, address, token, fingerprint ?? null, null, name);

        // Remember the key + device so ongoing sync just works.
        if (!get().settings.syncToken.trim()) {
          get().setSetting("syncToken", token);
          await secretsWriteTail;
          if (secretSaveError) throw new Error(`Sync key was not saved: ${secretSaveError}`);
        }
        if (!get().settings.syncEnabled) {
          get().setSetting("syncEnabled", true);
        }
        get().addPeer(address, name, fingerprint ?? result.fingerprint);

        await get().openVault(root); // scan + display the cloned vault
        set({
          syncStatus: `Cloned shared vault — ↓${result.pulled} file${result.pulled === 1 ? "" : "s"
            }`,
        });
        return result;
      } catch (e) {
        set({ loading: false, status: "" });
        throw e instanceof Error ? e : new Error(String(e));
      }
    },

    toggleListen: async () => {
      try { await loadSyncSecrets(); } catch { return; }
      const s = get();
      if (!s.vaultPath) return;
      if (!s.settings.syncEnabled) {
        set({ syncStatus: "Sync is disabled." });
        return;
      }
      if (s.syncListening) {
        try {
          await stopListening();
          set({ syncStatus: "Stopped listening." });
        } catch (error) {
          set({ syncStatus: `Could not stop server: ${String(error)}` });
        }
        return;
      }
      if (!validSyncKey(s.settings.syncToken)) {
        set({ syncStatus: "Generate a 64-character lowercase hex sync key before receiving." });
        return;
      }
      try {
        await startListening(s.vaultPath);
      } catch (e) {
        set({ syncStatus: `Could not start server: ${String(e)}` });
      }
    },

    ...createSyncWorkflow({
      get, set,
      generation: () => vault.generation,
      prepare: async () => {
        await loadSyncSecrets();
        await secretsWriteTail;
        if (secretSaveError) throw new Error(`Sync key was not saved: ${secretSaveError}`);
        await ensureSyncEventBridge();
      },
      transfer: (root, address, token, fingerprint, retry, admitted, peerName) =>
        import("./lib/sync").then(async ({ syncWithPeer, retireSyncPeers }) => {
          if (!admitted()) throw new Error("Sync cancelled before peer retirement.");
          await retireSyncPeers(root, get().settings.retiredSyncPeers ?? []);
          if (!admitted()) throw new Error("Sync cancelled before transfer.");
          return syncWithPeer(root, address, token, fingerprint, retry, peerName);
        }),
      cancel: () => import("./lib/sync").then(({ cancelSync }) => cancelSync()),
      refresh: vault.refreshMissingExternalFiles,
      log: logSyncLocal,
    }),
    saveConflictReview: async (root, rel, expected, content, copyRel) => {
      const generation = vault.generation;
      const current = () => get().vaultPath === root && vault.generation === generation;
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
      await vault.registerExternalFile(backupRel, current);
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
        documents.addNote(file, content);
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
        documents.addNote(file, `# ${title}\n\n`);
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

    getVaultGeneration: () => vault.generation,
    saveOverlayArtifact: async (kind, content, date, binding) => {
      const root = get().vaultPath;
      if (!root) {
        set({ status: "Open a vault before you save this item into it." });
        return null;
      }
      const generation = vault.generation;
      const current = () => get().vaultPath === root && vault.generation === generation;
      if (binding && (binding.root !== root || binding.generation !== generation)) return null;
      const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "")
        ? date!
        : localISO();
      const extension = kind === "scratchpad" ? "md" : "mesa-board.json";
      const folder = kind === "scratchpad" ? "Scratchpad" : "Whiteboard";
      // Stable paths preserve editable daily notes and vector boards.
      const rel = kind === "scratchpad"
        ? `${folder}/${safeDate}.${extension}`
        : `${folder}/Board.${extension}`;
      let saved: VaultFile | undefined;
      let superseded = false;
      await reportingFailure(`Save ${kind} into vault`, async () => {
        if (typeof content === "string") {
          await textSaves.flushAll();
          if (!current()) return;
          const existing = get().fileFor(rel);
          const read = existing ? await readNoteResult(existing) : null;
          if (!current()) return;
          if (read && !read.ok) throw new Error("Could not read the existing overlay document.");
          const disk = read?.ok ? read.text : null;
          const expected = binding ? binding.expected : disk;
          if (disk !== expected) throw new Error("The vault document changed. Your overlay draft is preserved; review the disk copy before saving.");
          if (existing) {
            if (textSaves.isDirty(existing.path)) throw new Error("This document has newer editor changes. Your overlay draft is preserved; finish those changes before saving.");
            const cached = get().contentCache[rel];
            textSaves.markDirty(existing.path, existing, content, expected ?? "");
            await textSaves.flush(existing.path);
            superseded = get().contentCache[rel] !== cached;
            saved = existing;
          } else {
            saved = await writeVaultTextFile(root, rel, content, { expectedMissing: true });
          }
        } else {
          saved = await writeVaultBinaryFile(
            root,
            rel,
            content instanceof Uint8Array ? content : new Uint8Array(),
            { expectedMissing: true }
          );
        }
      });
      if (!saved || !current()) return null;
      if (superseded) return saved.relPath;
      if (saved.isMarkdown) {
        const existing = get().files.some((file) => file.relPath === saved!.relPath);
        if (existing) {
          const text = String(content);
          set({
            ...(get().activePath === saved.relPath ? { content: String(content) } : {}),
            notes: {
              ...get().notes,
              [saved.relPath]: {
                relPath: saved.relPath,
                title: saved.name,
                rawLinks: extractLinks(text), tags: extractTags(text), aliases: extractAliases(text), firstImagePath: undefined,
              },
            },
            contentCache: forkContentCache(get().contentCache, { [saved.relPath]: text }),
            status: `Saved ${saved.relPath}.`,
          });
        } else documents.addNote(saved, String(content));
      } else {
        const existing = get().files.some((file) => file.relPath === saved!.relPath);
        bumpActivityAmount(saved.relPath, 1.3, existing ? "edit" : "create");
        set({
          files: existing
            ? get().files
            : [...get().files, saved].sort((a, b) => a.relPath.localeCompare(b.relPath)),
          contentCache: typeof content === "string"
            ? forkContentCache(get().contentCache, { [saved.relPath]: content })
            : get().contentCache,
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
        // Mutual exclusion: the Mesa overlay and the Pi overlay can't coexist
        // (no two Pi agent instances). Opening the Mesa overlay closes Pi.
        piOverlayOpen: open ? false : s.piOverlayOpen,
      })),
    toggleOverlay: () => {
      const next = !get().overlayOpen;
      set((s) => ({
        overlayOpen: next,
        // Opening the Mesa overlay closes the Pi overlay (mutual exclusion).
        piOverlayOpen: next ? false : s.piOverlayOpen,
      }));
    },
    setPiOverlayOpen: (open) =>
      set((s) => ({
        piOverlayOpen: open,
        // Mutual exclusion: opening the Pi overlay closes the Mesa overlay
        // (and its Pi window), so there is never more than one Pi instance.
        overlayOpen: open ? false : s.overlayOpen,
      })),
    setAgentOpen: (open) => set({ agentOpen: open }),
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
      documents.addNote(file, body);
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
          documents.addNote(file, content);
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
      // Report import failures so the progress message cannot remain visible.
      await reportingFailure("Import", async () => {
        activeImportAbort?.abort();
        const controller = new AbortController();
        activeImportAbort = controller;
        set({ status: "Importing…", importInProgress: true });
        let result;
        try {
          result = await importDroppedPaths(root, paths, {
            signal: controller.signal,
            onProgress: ({ completedSources, totalSources, current }) => set({
              status: `Importing ${completedSources}/${totalSources}: ${current}`,
            }),
          });
        } finally {
          if (activeImportAbort === controller) {
            activeImportAbort = null;
            set({ importInProgress: false });
          }
        }
        const { created, failures, cancelled } = result;
        if (created.length === 0) {
          if (cancelled) {
            set({ status: "Import cancelled before any files were copied." });
            return;
          }
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
          (cancelled
            ? `Import cancelled after ${created.length} file${created.length > 1 ? "s" : ""}`
            : `Imported ${created.length} file${created.length > 1 ? "s" : ""}`) +
          (failures.length > 0
            ? `; ${failures.length} failed: ${failures
              .map(({ name, message }) => `${name}: ${message}`)
              .join("; ")}`
            : "");
        // A deliberate stop leaves the user in the current vault with a clear
        // partial result; it must not unexpectedly switch into a half-imported
        // archive folder.
        if (!cancelled && paths.length === 1 && /\.zip$/i.test(paths[0])) {
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

    cancelImport: () => activeImportAbort?.abort(),

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
          // Hold child saves before awaiting removal; let in-flight writes settle.
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

    // Rename without changing extension or file bytes. Refresh note metadata and report failures through status.
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
      // Inspect all Markdown references for explicit rename repair; rawLinks omits embeds.
      // Verify each source update against concurrent edits.
      const bareNameUnambiguous = get().files.filter(
        (candidate) => `${candidate.name}.${candidate.ext}`.toLowerCase() === base.toLowerCase()
      ).length === 1;
      const noteResolver = makeResolver(get().notes);
      const inboundFiles = get().files.filter((candidate) => {
        if (!candidate.isMarkdown || candidate.relPath === relPath) return false;
        const metadata = get().notes[candidate.relPath];
        // A v2 disposable index can briefly survive an interrupted upgrade.
        // Safely inspect that source once rather than miss a reference; v3
        // entries always carry `rawReferences`, so normal renames stay bounded
        // by actual candidate count instead of vault Markdown count.
        if (!metadata?.rawReferences) return true;
        if (file.isMarkdown && metadata.rawLinks.some((link) => {
          const sourceDir = candidate.relPath.includes("/")
            ? candidate.relPath.slice(0, candidate.relPath.lastIndexOf("/"))
            : "";
          return noteResolver(link) === relPath ||
            noteResolver(normalizeRelativeTarget(sourceDir, link)) === relPath;
        })) return true;
        return metadata.rawReferences.some((reference) =>
          referenceMayTarget(candidate.relPath, reference, relPath, bareNameUnambiguous)
        );
      });
      // Hold this identity across the OS rename. Existing edits are flushed to
      // establish the disk baseline; edits typed while rename is in flight stay
      // paused and move to the new absolute key after success.
      let saveHold: TextSaveHold<VaultFile> | undefined;
      let linkHold: TextSaveHold<VaultFile> | undefined;
      let historyMigrationFailed = false;
      let newFile: VaultFile;
      const linkUpdates: Array<{ file: VaultFile; before: string; after: string }> = [];
      try {
        saveHold = await textSaves.hold([file.path], true);
        if (inboundFiles.length) {
          linkHold = await textSaves.hold(inboundFiles.map((candidate) => candidate.path), true);
          for (const inbound of inboundFiles) {
            const before = get().contentCache[inbound.relPath] ?? await readNote(inbound);
            const { text, changed } = rewriteInboundLinks(
              inbound.relPath,
              before,
              relPath,
              newRel,
              noteResolver,
              file.isMarkdown,
              bareNameUnambiguous
            );
            if (changed) linkUpdates.push({ file: inbound, before, after: text });
          }
        }
        newFile = await renameVaultFile(root, relPath, newRel);
        saveHold.move(file.path, newFile.path, newFile);
        // Revision history is independent from the verified filesystem rename.
        // A storage failure must not undo the completed rename, but the user
        // must not lose the identity silently.
        if (!(await migrateTextRevisionsAsync(root, relPath, newRel))) {
          historyMigrationFailed = true;
        }
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
          rawReferences: extractLinksAndFirstImage(update.after).references,
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
        status: historyMigrationFailed
          ? `Renamed ${relPath}, but local revision history could not move.`
          : linkUpdateError
            ? `Renamed ${relPath}, but updating inbound links stopped: ${linkUpdateError}`
            : appliedLinkUpdates.length
              ? `Renamed ${relPath} and updated ${appliedLinkUpdates.length} inbound ${appliedLinkUpdates.length === 1 ? "link" : "links"}`
              : `Renamed ${relPath}`,
      });
    },

    ...persistence.actions,
    ...documents.actions,
    ...research.actions,
    ...vault.actions,
    ...windows.actions,
    fileFor: (relPath) => fileIndexFor(get().files).get(relPath),
  };
});

/** Convenience for non-react callers. */
export function getStore() {
  return useAppStore.getState();
}
