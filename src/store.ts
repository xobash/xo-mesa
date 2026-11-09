import { create } from "zustand";
import { createCalendarController } from "./controllers/calendar";
import { createDocumentController } from "./controllers/documents";
import { createFileOpsController } from "./controllers/fileOps";
import { createPersistenceController } from "./controllers/persistence";
import { createRenameController } from "./controllers/rename";
import { createResearchController } from "./controllers/research";
import { createSyncPeersController } from "./controllers/syncPeers";
import { createVaultController } from "./controllers/vault";
import { createWorkspaceController } from "./controllers/workspace";
import { NO_DOC_SPLIT } from "./lib/docSplit";
import { bumpActivityAmount, type ActivityOp } from "./lib/activity";
import { confirmAction } from "./lib/confirmAction";
import { normalizeSyncPort } from "./lib/pairing";
import { normalizeAutoSyncMinutes } from "./lib/syncAutoSchedule";
import { loadSettings } from "./lib/settings";
import { IN_TAURI, isTextualVaultFile } from "./lib/vault";
import { forgetVaultIndex } from "./lib/vaultIndex";

import { listen } from "@tauri-apps/api/event";
import { createFileIndex } from "./lib/fileIndex";
import {
  THEME_KEY,
  initialRecents,
  forgetRecentVaultNative,
  resolveRecentVault,
  initialTheme,
  type ThemeId,
  UI_STYLE_KEY,
  initialUiStyle,
  type UiStyleId
} from "./lib/persistedUi";
import { createSyncEventBridge } from "./lib/syncEventBridge";
import type { AppState } from "./storeTypes";
export type {
  AppState,
  DeepResearchRunState,
  DragGhost,
  TextSaveIssue,
  ThemeId,
  UiStyleId,
  UnreadableTextReason,
  VaultUnavailableState,
} from "./storeTypes";

/** `swatch` is [surface, accent] for the picker chip; keep in sync with the theme tokens in styles/tokens.css. */
export const THEMES: { id: ThemeId; label: string; blurb: string; swatch: [string, string] }[] = [
  { id: "system", label: "System", blurb: "Neutral, follows OS light/dark", swatch: ["#1c1d21", "#aab4c5"] },
  { id: "void", label: "Void", blurb: "Violet pulse on black", swatch: ["#08080a", "#7259cc"] },
  { id: "darkroom", label: "Darkroom", blurb: "Cinematic monochrome", swatch: ["#0c0c0c", "#ffffff"] },
  { id: "graphite", label: "Graphite", blurb: "Soft charcoal, ivory ink", swatch: ["#121213", "#eceae5"] },
  { id: "midnight", label: "Midnight", blurb: "Ink blue, ice accent", swatch: ["#0e1117", "#8db3ff"] },
  { id: "ember", label: "Ember", blurb: "Warm charcoal, amber light", swatch: ["#171412", "#e5a65e"] },
  { id: "dusk", label: "Dusk", blurb: "Plum night, rose accent", swatch: ["#151119", "#eaa6bc"] },
  { id: "fjord", label: "Fjord", blurb: "Nordic slate, frost accent", swatch: ["#1f232b", "#88c0d0"] },
  { id: "paper", label: "Paper", blurb: "Warm light, rust accent", swatch: ["#fbf9f5", "#b0522c"] },
];

/** Interface styles change shell shape and density only; every theme works with each. */
export const UI_STYLES: { id: UiStyleId; label: string; blurb: string }[] = [
  { id: "classic", label: "Classic", blurb: "Original Mesa chrome: compact, mono labels" },
  { id: "studio", label: "Studio", blurb: "Calm and roomy, rounded surfaces" },
  { id: "vault", label: "Vault", blurb: "Dense panes and tab headers" },
  { id: "canvas", label: "Canvas", blurb: "Minimal, borderless, floating panels" },
];


export const useAppStore = create<AppState>((set, get) => {
  // Report failed vault mutations through status. Rebuild the file lookup
  // index only when the file list changes.
  const fileIndexFor = createFileIndex();
  const bootSettings = loadSettings();

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
          if (!rootRaw) return;
          const generation = vault.generation;
          const isCurrent = () => get().vaultPath === rootRaw && vault.generation === generation;
          const rel = await vault.resolveActivityPath(String(data.path ?? ""), op, rootRaw, isCurrent);
          if (!rel) return;
          const amount = op === "read" ? 0.7 : op === "create" ? 1.3 : 1.0;
          bumpActivityAmount(rel, amount, op, status, detail, {
            added: Number.isFinite(added) ? added : 0,
            removed: Number.isFinite(removed) ? removed : 0,
          });
          // Activity cards need only a bounded excerpt. A full ensureContent
          // here let Pi activity bypass the startup search-cache budget and
          // retain every touched text file for the whole session.
          const activityFile = get().fileFor(rel);
          if (activityFile && isTextualVaultFile(activityFile)) {
            void get().ensurePeek(rel).catch(() => undefined);
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
  const sync = createSyncPeersController({
    get, set, bootSettings: bootSettings.settings, reportingFailure,
    ensureSyncEventBridge, logSyncLocal,
    getGeneration: () => vault.generation,
    refreshMissingExternalFiles: (...args) => vault.refreshMissingExternalFiles(...args),
  });
  const { commitSettings } = sync;
  const documents = createDocumentController({
    get, set, textSaves, commitSettings, reportingFailure,
    getGeneration: () => vault.generation,
  });
  const research = createResearchController({
    get, set, getGeneration: () => vault.generation,
    registerExternalFile: (...args) => vault.registerExternalFile(...args),
    refreshMissingExternalFiles: (...args) => vault.refreshMissingExternalFiles(...args),
    textSaves,
  });
  const vault = createVaultController({
    get, set, textSaves, resetDocuments: documents.reset,
    stopResearch: research.stop, setupActivityBridge, ensureSyncEventBridge,
    stopListening: sync.stopListening, startListening: sync.startListening,
  });
  const windows = createWorkspaceController({ get, set, commitSettings });
  const fileOps = createFileOpsController({
    get, set, textSaves, reportingFailure, saveTextMutation, clearTextSaveIssues,
    addNote: documents.addNote,
    getGeneration: () => vault.generation,
    registerExternalFile: (...args) => vault.registerExternalFile(...args),
  });
  const rename = createRenameController({ get, set, textSaves, getGeneration: () => vault.generation });
  const calendar = createCalendarController({
    get, set, reportingFailure, saveTextMutation, addNote: documents.addNote,
    getGeneration: () => vault.generation,
  });
  return {
    vaultPath: null,
    vaultName: "",
    unavailableVault: null,
    recentVaults: initialRecents(),
    currentRecentVaultId: null,
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
    dirtyBinaryPaths: [],
    theme: initialTheme(),
    uiStyle: initialUiStyle(),
    docSplit: NO_DOC_SPLIT,
    settings: bootSettings.settings,
    settingsIssue: bootSettings.issue,
    paletteOpen: false,
    paletteMode: "files",
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
    notesIndexPending: false,

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

    setUiStyle: (style) => {
      try {
        localStorage.setItem(UI_STYLE_KEY, style);
      } catch {
        /* ignore */
      }
      set({ uiStyle: style });
    },

    setSetting: (key, value) => {
      const safeValue =
        key === "syncPort"
          ? normalizeSyncPort(value, get().settings.syncPort)
          : key === "syncAutoMinutes"
            ? normalizeAutoSyncMinutes(value)
            : value;
      const settings = { ...get().settings, [key]: safeValue };
      commitSettings(settings);
      sync.settingChanged(key, safeValue);
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

    setPalette: (open) => set({ paletteOpen: open, paletteMode: "files" }),
    openTemplatePicker: () => set({ paletteOpen: true, paletteMode: "templates" }),
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
    openRecentVault: async (id) => {
      try { await get().openVault(await resolveRecentVault(id)); }
      catch { set({ status: "Could not open the recent vault. Select its folder again." }); }
    },
    removeRecentVault: async (id) => {
      try {
        const state = await forgetRecentVaultNative(id);
        if (id === get().currentRecentVaultId && get().vaultPath) void forgetVaultIndex(get().vaultPath!);
        set({ recentVaults: state.entries, currentRecentVaultId: id === get().currentRecentVaultId ? null : get().currentRecentVaultId });
      } catch { set({ status: "Could not remove the recent vault." }); }
    },
    clearRecentVaults: async () => {
      try { await forgetRecentVaultNative(); set({ recentVaults: [], currentRecentVaultId: null }); }
      catch { set({ status: "Could not clear recent vaults." }); }
    },

    clearSyncLog: () =>
      set({ syncLog: [], syncProgress: null, syncReport: null }),
    setPopoutDoc: (rel) => set({ popoutDoc: rel }),
    getVaultGeneration: () => vault.generation,

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

    ...sync.actions,
    ...fileOps.actions,
    ...rename.actions,
    ...calendar.actions,
    ...persistence.actions,
    ...documents.actions,
    ...research.actions,
    ...vault.actions,
    registerVaultFile: async (relPath) => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = vault.generation;
      const current = () => get().vaultPath === root && vault.generation === generation;
      await vault.registerExternalFile(relPath, current);
      if (!get().fileFor(relPath) && current()) await vault.refreshMissingExternalFiles(root, current);
    },
    ...windows.actions,
    fileFor: (relPath) => fileIndexFor(get().files).get(relPath),
    setBinaryDirty: (relPath, dirty) => {
      const paths = get().dirtyBinaryPaths;
      if (paths.includes(relPath) === dirty) return;
      set({ dirtyBinaryPaths: dirty ? [...paths, relPath] : paths.filter((path) => path !== relPath) });
    },
    confirmDiscardBinaryEdits: async (relPaths, action) => {
      const dirty = get().dirtyBinaryPaths.filter((path) => !relPaths ||
        relPaths.some((rel) => path === rel || path.startsWith(`${rel.replace(/\/+$/, "")}/`)));
      if (!dirty.length) return true;
      return confirmAction(
        `${dirty.join(", ")} ${dirty.length === 1 ? "has" : "have"} unsaved PDF edits. ${action} will discard them.`,
        { title: "Discard PDF edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning" }
      );
    },
  };
});

/** Convenience for non-react callers. */
export function getStore() {
  return useAppStore.getState();
}
