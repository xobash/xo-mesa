import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getStore, useAppStore } from "../store";
import { collectVaultTasks } from "../lib/tasks";
import { localISO } from "../lib/daily";
import { buildTraySnapshot } from "../lib/trayStatus";
import { readGraphColors } from "./graphColors";
import { miniGraph, popoverFile, popoverVaults, rememberRecent, searchFiles, type MiniGraph, type TrayPopoverState } from "../lib/trayPopover";

const TRAY_ACTION_EVENT = "mesa://tray-action";
const POPOVER_REQUEST_EVENT = "mesa://tray-popover-request";
const POPOVER_STATE_EVENT = "mesa://tray-popover-state";
const POPOVER_LABEL = "tray";
/** Coalesce store churn (typing, indexing) into at most one native update per second. */
const TRAY_UPDATE_MS = 1000;

function snapshotOf(s: ReturnType<typeof getStore>) {
  return buildTraySnapshot({
    vaultName: s.vaultPath ? s.vaultName : null,
    saveState: s.textSaveState,
    tasks: s.vaultPath ? collectVaultTasks(s.notes, s.contentCache, (s.settings.tasksFile || "Tasks.md").trim()) : [],
    today: localISO(),
    researchPhase: s.deepResearch?.phase ?? null,
    syncEnabled: s.settings.syncEnabled,
    syncBusy: s.syncBusy,
    syncPeers: s.settings.peers.length,
  });
}

interface TrayAction {
  action: "search" | "tasks" | "settings" | "task" | "note" | "new-note" | "daily" | "vault" | "sync-toggle" | "sync-now" | "pi" | "graph";
  rel?: string;
  id?: string;
  query?: string;
}

/**
 * Keeps the native menu-bar / tray item current for the main window and
 * serves the menu bar popover. Uses effect-owned store subscriptions so the
 * App shell never re-renders for it.
 */
export function useTrayStatus(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = "";
    let recents: string[] = [];
    let lastActive: string | null = null;
    let lastVault: string | null = null;
    let graphKey: unknown[] = [];
    let graph: MiniGraph | null = null;
    const exists = (rel: string) => !!getStore().fileFor(rel);
    const trackRecent = () => {
      const s = getStore();
      if (s.vaultPath !== lastVault) { lastVault = s.vaultPath; recents = []; lastActive = null; }
      if (s.activePath !== lastActive) {
        lastActive = s.activePath;
        recents = rememberRecent(recents, s.activePath, exists);
      }
    };
    const push = () => {
      timer = null;
      const s = getStore();
      const snapshot = snapshotOf(s);
      const json = JSON.stringify(snapshot);
      if (json === lastSent || disposed) return;
      lastSent = json;
      invoke("tray_update", { snapshot }).catch(() => { lastSent = ""; });
    };
    const schedule = () => {
      trackRecent();
      if (!timer) timer = setTimeout(push, TRAY_UPDATE_MS);
    };
    const popoverState = (query: string): TrayPopoverState => {
      trackRecent();
      const s = getStore();
      const open = !!s.vaultPath;
      const key = [s.notes, s.files, s.activePath, s.notesIndexPending, open];
      if (!graph || key.some((v, i) => v !== graphKey[i])) {
        graphKey = key;
        graph = open
          ? miniGraph(s.notes, s.files, s.activePath, s.notesIndexPending)
          : { nodes: [], links: [], active: -1, total: 0, pending: false };
      }
      const snapshot = snapshotOf(s);
      return {
        vault: snapshot.vault,
        save: snapshot.save,
        research: snapshot.research,
        tasksSummary: snapshot.tasksSummary,
        sync: { enabled: s.settings.syncEnabled, busy: s.syncBusy, label: snapshot.sync.replace(/^Sync: /, "") },
        recents: open ? recents.flatMap((rel) => { const f = s.fileFor(rel); return f ? [popoverFile(f)] : []; }) : [],
        vaults: popoverVaults(s.recentVaults, s.currentRecentVaultId),
        query,
        results: open ? searchFiles(s.files, query) : [],
        graph,
        palette: (({ node, nodeActive, nodeIsolated, link, flickerRgb, bloomAlpha }) =>
          ({ node, nodeActive, nodeIsolated, link, glowRgb: flickerRgb, bloomAlpha }))(readGraphColors()),
      };
    };
    const act = (payload: TrayAction) => {
      const st = getStore();
      switch (payload.action) {
        case "search": st.openSearch(payload.query ?? ""); break;
        case "tasks": st.setTasksOpen(true); break;
        case "settings": st.setSettingsOpen(true); break;
        case "task":
        case "note": if (payload.rel && st.fileFor(payload.rel)) void st.selectFile(payload.rel); break;
        case "new-note": if (st.vaultPath) void st.newNote(); break;
        case "daily": if (st.vaultPath) void st.openDailyNote(localISO()); break;
        case "vault": if (payload.id && st.recentVaults.some((v) => v.id === payload.id)) void st.openRecentVault(payload.id); break;
        case "sync-toggle": st.setSetting("syncEnabled", !st.settings.syncEnabled); break;
        case "sync-now": if (st.settings.syncEnabled && !st.syncBusy) void st.syncAll(); break;
        case "pi": st.setAgentOpen(true); break;
        case "graph": if (st.vaultPath && !st.graphFull) st.toggleGraphFull(); break;
      }
    };
    trackRecent();
    push();
    const unsubscribe = useAppStore.subscribe(schedule);
    const unlisteners: (() => void)[] = [];
    const keep = (off: () => void) => { if (disposed) off(); else unlisteners.push(off); };
    void listen<TrayAction>(TRAY_ACTION_EVENT, ({ payload }) => act(payload)).then(keep);
    void listen<{ query?: string }>(POPOVER_REQUEST_EVENT, ({ payload }) => {
      void emitTo(POPOVER_LABEL, POPOVER_STATE_EVENT, popoverState(payload.query ?? "")).catch(() => {});
    }).then(keep);
    return () => {
      disposed = true;
      unsubscribe();
      unlisteners.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
