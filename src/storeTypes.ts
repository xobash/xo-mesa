/** Store state and action types, kept apart from the store module so
 *  controllers and lib helpers can type their state ports without importing
 *  the store singleton. `store.ts` re-exports every type here. */
import type { CalEvent } from "./lib/daily";
import type { DeepResearchContext, DeepResearchLaunchStage, DeepResearchPhase, DeepResearchResult, ResearchActivity, ResearchChangeSet, ResearchContextScope, ResearchDepth } from "./lib/deepResearch";
import type { DocPaneId, DocSplit } from "./lib/docSplit";
import type { KeyboardFocus } from "./lib/keyboardNav";
import type { PaneDrag } from "./lib/panes";
import type { RecentVault, ThemeId, UiStyleId } from "./lib/persistedUi";
import type { SyncLogEntry, SyncPhase, SyncProgress, SyncReport } from "./lib/sync";
import type { TaskLinePatch } from "./lib/tasks";
import type { TextRevision } from "./lib/textRevisionHistory";
import type { TextSaveState } from "./lib/textSaveCoordinator";
import type { RecoveryEntry } from "./lib/vault";
import type { DetachedWindowPlacement } from "./lib/windowTearOff";
import type { NoteMeta, PaneView, PreviewTarget, RightPanel, Settings, SyncPeer, VaultFile, WorkspacePreset } from "./types";

export type { ThemeId, UiStyleId } from "./lib/persistedUi";

export interface DragGhost {
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
}

export interface VaultUnavailableState {
  root: string;
  name: string;
  reason: string;
}

export type UnreadableTextReason = "skipped" | "offline" | "failed";

export interface AppState {
  vaultPath: string | null;
  vaultName: string;
  /** Remembered network/removable vault that is selected but not currently
   * reachable. It is not a valid empty workspace; App retries it in place. */
  unavailableVault: VaultUnavailableState | null;
  recentVaults: RecentVault[];
  currentRecentVaultId: string | null;
  openRecentVault: (id: string) => Promise<void>;
  clearRecentVaults: () => Promise<void>;
  calendarEvents: CalEvent[];
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
  contentCache: Record<string, string>;
  openTabs: string[];
  activePath: string | null;
  content: string;
  activeContentState: "ready" | "loading" | "failed" | "size-limit" | "invalid-encoding";
  graphFull: boolean;
  loading: boolean;
  status: string;
  /** Every dirty text path whose verified write failed. */
  textSaveIssues: Record<string, TextSaveIssue>;
  textSaveState: TextSaveState;
  /** Vault paths whose open PDF editor holds unsaved edits (not in the text pipeline). */
  dirtyBinaryPaths: readonly string[];
  theme: ThemeId;
  uiStyle: UiStyleId;
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
  syncPhase: SyncPhase;
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
  /** Why a text file is matched by name only: over the size limit, online-only
   *  in cloud storage (not downloaded by background indexing), or unreadable. */
  unreadableTextReasons: Record<string, UnreadableTextReason>;
    /** Text files still awaiting background indexing after vault open.
   * Non-zero means search and other indexed views have incomplete coverage. */
  indexingTextFiles: number;
  /** True from a vault open until its first note-index publication (stored
   *  index, completed pass, or failure). Directly opened notes do not clear it. */
  notesIndexPending: boolean;

  setTheme: (t: ThemeId) => void;
  setUiStyle: (style: UiStyleId) => void;
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
  /** User-facing discard: confirms first when an unapplied proposal would be
   * lost. Resolves true when the run was discarded. */
  requestDiscardDeepResearch: () => Promise<boolean>;
  openDailyNote: (dateISO: string) => Promise<void>;
  /** Turn one unlinked mention in `sourceRel` into a wiki link to `targetRel`
   * through the verified text-save queue. False when the text changed or the
   * write failed (the failure is reported through `status`). */
  linkUnlinkedMention: (sourceRel: string, mention: { start: number; end: number; text: string }, targetRel: string) => Promise<boolean>;
  /** Read a template note and fill `{{date}}`, `{{time}}` and `{{title}}` for the active note. */
  renderTemplate: (templateRel: string) => Promise<string | null>;
  addCalendarEvent: (date: string, title: string) => Promise<void>;
  removeCalendarEvent: (date: string, title: string) => Promise<void>;
  /** Resolves true once the task is in the vault or its pending save; false when it was not added. */
  addPersonalTask: (text: string) => Promise<boolean>;
  /** `expectedText` (the listed task text) refuses a line that has since changed. */
  updateTask: (relPath: string, line: number, patch: TaskLinePatch, expectedText?: string) => Promise<void>;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  loadSyncSecrets: () => Promise<void>;
  /** After typed confirmation: replace damaged saved keys with a new device key; every peer must pair again. */
  resetSyncKeys: () => Promise<void>;
  setPalette: (open: boolean) => void;
  /** What the open palette lists: files (and `>` commands) or templates to insert. */
  paletteMode: "files" | "templates";
  openTemplatePicker: () => void;
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
  /** Side-by-side documents: which document pane is live and what the other shows. */
  docSplit: DocSplit;
  /** Open a file beside the current document (split view). */
  openToSide: (relPath: string) => Promise<void>;
  /** Open a file dropped on a workspace region in that region. */
  openFileInRegion: (relPath: string, region: "center" | "right") => Promise<void>;
  /** Make a document pane the live editor. */
  focusDocPane: (pane: DocPaneId) => Promise<void>;
  /** Returns true only after the detached window has adopted the live PTY. */
  openAgentWindow: (placement?: DetachedWindowPlacement) => Promise<boolean>;
  /** Open the shared Deep Research view in a separate Mesa native window. */
  openResearchWindow: (placement?: DetachedWindowPlacement) => Promise<boolean>;
  openVault: (path?: string) => Promise<void>;
  registerVaultFile: (relPath: string) => Promise<void>;
  removeRecentVault: (id: string) => Promise<void>;
  selectFile: (relPath: string) => Promise<void>;
  setBinaryDirty: (relPath: string, dirty: boolean) => void;
  /** Resolves true when no listed path (or path under a listed folder; null = all)
   *  has unsaved PDF edits, or when the user confirms discarding them. */
  confirmDiscardBinaryEdits: (relPaths: readonly string[] | null, action: string) => Promise<boolean>;
  loadActiveContent: () => Promise<void>;
  openFile: (relPath: string) => Promise<void>;
  openTarget: (target: string) => Promise<void>;
  setContentFromEditor: (text: string, activity?: { snippet: string; lines: { added: number; removed: number }; tasksUnchanged?: boolean }) => void;
  flushSave: () => Promise<void>;
  pendingTextSaves: () => ReadonlyArray<Readonly<{ key: string; target: VaultFile; content: string; failed: boolean }>>;
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
