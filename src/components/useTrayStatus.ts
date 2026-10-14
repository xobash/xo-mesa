import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getStore, useAppStore } from "../store";
import { collectVaultTasks } from "../lib/tasks";
import { localISO } from "../lib/daily";
import { buildTraySnapshot } from "../lib/trayStatus";

const TRAY_ACTION_EVENT = "mesa://tray-action";
/** Coalesce store churn (typing, indexing) into at most one native update per second. */
const TRAY_UPDATE_MS = 1000;

interface TrayAction { action: "search" | "tasks" | "settings" | "task"; rel?: string }

/**
 * Keeps the native menu-bar / tray item current for the main window. Uses an
 * effect-owned store subscription so the App shell never re-renders for it.
 */
export function useTrayStatus(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = "";
    const push = () => {
      timer = null;
      const s = getStore();
      const snapshot = buildTraySnapshot({
        vaultName: s.vaultPath ? s.vaultName : null,
        saveState: s.textSaveState,
        tasks: s.vaultPath ? collectVaultTasks(s.notes, s.contentCache, (s.settings.tasksFile || "Tasks.md").trim()) : [],
        today: localISO(),
        researchPhase: s.deepResearch?.phase ?? null,
        syncEnabled: s.settings.syncEnabled,
        syncBusy: s.syncBusy,
        syncPeers: s.settings.peers.length,
      });
      const json = JSON.stringify(snapshot);
      if (json === lastSent || disposed) return;
      lastSent = json;
      invoke("tray_update", { snapshot }).catch(() => { lastSent = ""; });
    };
    const schedule = () => { if (!timer) timer = setTimeout(push, TRAY_UPDATE_MS); };
    push();
    const unsubscribe = useAppStore.subscribe(schedule);
    let unlisten: (() => void) | null = null;
    void listen<TrayAction>(TRAY_ACTION_EVENT, ({ payload }) => {
      const st = getStore();
      if (payload.action === "search") st.openSearch();
      else if (payload.action === "tasks") st.setTasksOpen(true);
      else if (payload.action === "settings") st.setSettingsOpen(true);
      else if (payload.action === "task" && payload.rel) void st.selectFile(payload.rel);
    }).then((off) => { if (disposed) off(); else unlisten = off; });
    return () => {
      disposed = true;
      unsubscribe();
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
