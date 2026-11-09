import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { useAppStore, getStore } from "../store";
import type { AppState } from "../store";
import { IN_TAURI, DEMO_ROOT } from "../lib/vault";
import { syncSecretsNeededAtStartup } from "../lib/syncSecrets";
import { loadRecentVaults, resolveRecentVault } from "../lib/persistedUi";
import { flushBeforeClose, hideOrQuitMain, installCloseGuard, pendingEditGuard, type BlockedClose } from "../lib/closeGuard";
import { hasToured } from "./Guide";
import { DOCUMENT_CATALOG_EVENT, DOCUMENT_CATALOG_REQUEST_EVENT } from "./DocumentView";
import { isAppModifier } from "../lib/hotkeys";
import {
  adjacentPath,
  clampKeyboardFocus,
  edgePath,
  keyboardFileOrder,
  moveKeyboardFocus,
} from "../lib/keyboardNav";
import { DOCK_WINDOW_EVENT, GLOBAL_AGENT_EVENT, normalizeDockWindowPayload } from "../lib/windowDock";
import {
  claimPlainShiftTabToggle,
  claimKeyboardShortcut,
  isPlainShiftTab,
  isTextEntryTarget,
  notePlainShiftTabKeyUp,
  resetPlainShiftTabChord,
} from "../lib/shortcuts";
import { AGENT_CONTEXT_EVENT } from "../lib/piSessionBridge";
import { buildAgentContext, contextPrompt } from "../lib/agent";
import { LatestWinsQueue, SupersededTaskError } from "../lib/latestWinsQueue";
import { autoSyncBaseDelayMs, nextAutoSyncDelayMs } from "../lib/syncAutoSchedule";

const QUIT_REQUESTED_EVENT = "mesa://quit-requested";

// Main-workspace context changes can be faster than Tauri IPC completion
// (e.g. keyboard navigation through notes). Serialize them and skip queued
// stale values so Rust's per-turn context can never settle on an older view.
const PI_CONTEXT_PUBLISH_QUEUE = new LatestWinsQueue<string, void>();

const { flush: flushAllEdits, pending: hasPendingEdits } = pendingEditGuard(getStore);

/**
 * Effects that only the main window runs: catalog and context relays, close
 * and quit guards, vault auto-open and retry, auto-sync, dock events, first
 * focus and shell keyboard routing. Detached windows pass `mainWindow: false`
 * and every effect stays inert. Effects keep their relative order, which
 * fixes listener registration order (capture-phase keys included).
 */
export function useMainWindowEffects({
  mainWindow,
  vaultPath,
  unavailableVault,
  openVault,
  requestedVault,
  onBlocked,
  appRootRef,
}: {
  mainWindow: boolean;
  vaultPath: AppState["vaultPath"];
  unavailableVault: AppState["unavailableVault"];
  openVault: AppState["openVault"];
  requestedVault: string;
  onBlocked: BlockedClose;
  appRootRef: RefObject<HTMLDivElement | null>;
}): void {
  const syncAutoMinutes = useAppStore((s) => s.settings.syncAutoMinutes);
  const syncEnabled = useAppStore((s) => s.settings.syncEnabled);
  const syncPeerCount = useAppStore((s) => s.settings.peers.length);
  const syncToken = useAppStore((s) => s.settings.syncToken);
  const vimPrefixRef = useRef<"g" | "window" | null>(null);
  const leftShiftDownRef = useRef(false);

  // Detached documents reuse the main renderer's live file catalog. They
  // read only their selected document and never start another vault walk.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<{ label?: string; vault?: string }>(DOCUMENT_CATALOG_REQUEST_EVENT, (event) => {
      const { label, vault } = event.payload ?? {};
      const state = getStore();
      if (!label?.startsWith("doc-") || !vault || vault !== state.vaultPath) return;
      void emitTo(label, DOCUMENT_CATALOG_EVENT, { vault, files: state.files })
        .catch((error) => console.warn("[mesa] document catalog delivery failed:", error));
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    }).catch((error) => console.warn("[mesa] document catalog relay failed:", error));
    return () => { alive = false; unlisten?.(); };
  }, [mainWindow]);

  // Main owns live workspace context. Detached Pi surfaces receive it but never publish it back.
  // Publish from a store subscription: navigation and settings changes must
  // not re-render the whole shell just to rebuild this context.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let published: Pick<AppState, "vaultName" | "vaultPath" | "activePath" | "openTabs" | "settings"> | null = null;
    const publish = (state: AppState) => {
      if (
        published &&
        published.vaultName === state.vaultName &&
        published.vaultPath === state.vaultPath &&
        published.activePath === state.activePath &&
        published.openTabs === state.openTabs &&
        published.settings === state.settings
      ) return;
      const { vaultName, vaultPath, activePath, openTabs, settings } = state;
      published = { vaultName, vaultPath, activePath, openTabs, settings };
      const liveAgentContext = buildAgentContext({ vaultName, vaultPath, activePath, openTabs, settings });
      const context = vaultPath ? contextPrompt(liveAgentContext) : "";
      void PI_CONTEXT_PUBLISH_QUEUE.enqueue(context, async () => {
        await invoke("activity_set_context", { context });
        if (vaultPath) await emit(AGENT_CONTEXT_EVENT, liveAgentContext);
      }).catch((error) => {
        if (!(error instanceof SupersededTaskError)) {
          console.warn("[mesa] Pi context publish failed:", error);
        }
      });
    };
    publish(getStore());
    return useAppStore.subscribe(publish);
  }, [mainWindow]);

  // Pi's mesa_view tool asks main for the rendered pixels of the current view.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<string>("mesa://view-request", (event) => {
      const state = getStore();
      void import("../lib/viewCapture").then(({ answerViewRequest }) =>
        answerViewRequest(event.payload, state.activePath, state.settings.centerView)
      ).catch((error) => {
        console.warn("[mesa] Pi view capture failed:", error);
      });
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [mainWindow]);

  // First-run guided tour, once the vault is open.
  useEffect(() => {
    if (!mainWindow || !vaultPath || hasToured()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let userStartedAction = false;
    const activeAction = () => {
      const state = getStore();
      return userStartedAction || state.loading || state.searchOpen || state.paletteOpen ||
        state.settingsOpen || state.diagnosticsOpen || state.syncOpen || state.helpOpen ||
        state.tasksOpen || !!state.popoutDoc || state.overlayOpen || state.tourOpen;
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (activeAction()) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!activeAction() && !hasToured()) getStore().setTourOpen(true);
      }, 450);
    };
    let wasActive = activeAction();
    schedule();
    const onUserAction = () => {
      userStartedAction = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    window.addEventListener("pointerdown", onUserAction, true);
    window.addEventListener("keydown", onUserAction, true);
    const unsubscribe = useAppStore.subscribe(() => {
      const isActive = activeAction();
      if (isActive !== wasActive) {
        wasActive = isActive;
        schedule();
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("pointerdown", onUserAction, true);
      window.removeEventListener("keydown", onUserAction, true);
    };
  }, [vaultPath, mainWindow]);

  // Tauri close requests are cancellable. Hold the main window open until all
  // dirty paths finish verified writes, then hide it; a failed save leaves the
  // window and editor intact so the user can resolve the reported conflict.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      const current = getCurrentWindow();
      // Mesa keeps running behind its Dock or tray icon; without a visible
      // tray (Linux, a failed tray) closing main quits after the same flush.
      stop = installCloseGuard(
        current,
        flushAllEdits,
        hasPendingEdits,
        (status) => useAppStore.setState({ status }),
        onBlocked,
        () => hideOrQuitMain(() => invoke<boolean>("main_close_hides"), () => current.hide(), () => invoke("quit_after_save"))
      );
    }).catch((error) => {
      if (!disposed) useAppStore.setState({ status: `Close safety failed to start: ${String(error)}` });
    });
    return () => { disposed = true; stop?.(); };
  }, [mainWindow, onBlocked]);

  // macOS Quit requests bypass a window's close handler. Hold the app alive
  // until the same verified text flush succeeds, including failed-save cases.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let disposed = false;
    let flushingQuit = false;
    let stop: (() => void) | undefined;
    void listen(QUIT_REQUESTED_EVENT, async () => {
      if (flushingQuit) return;
      flushingQuit = true;
      useAppStore.setState({ status: "Saving text before Quit…" });
      try {
        await flushBeforeClose(flushAllEdits);
        if (disposed) return;
        if (hasPendingEdits()) {
          throw new Error("changes still need attention");
        }
        useAppStore.setState({ status: "Text saved. Closing Mesa…" });
        await invoke("quit_after_save");
      } catch (reason) {
        if (disposed) return;
        useAppStore.setState({ status: `Quit stopped: ${String(reason)}` });
        if (await onBlocked(reason) === "discard" && !disposed) await invoke("quit_after_save");
      } finally {
        flushingQuit = false;
      }
    }).then(async (unlisten) => {
      if (disposed) { unlisten(); return; }
      stop = unlisten;
      await invoke("quit_guard_arm");
      if (disposed) await invoke("quit_guard_disarm");
    }).catch((reason) => {
      if (!disposed) useAppStore.setState({ status: `Quit safety failed to start: ${String(reason)}` });
    });
    return () => {
      disposed = true;
      stop?.();
      void invoke("quit_guard_disarm");
    };
  }, [mainWindow, onBlocked]);

  // Auto-open: demo vault in the browser, last-used vault in the desktop app.
  useEffect(() => {
    if (!IN_TAURI || !mainWindow) return;
    if (!syncSecretsNeededAtStartup(getStore().settings)) return;
    void getStore().loadSyncSecrets().catch(() => undefined);
  }, [mainWindow]);

  useEffect(() => {
    if (!mainWindow || useAppStore.getState().vaultPath) return;
    if (!IN_TAURI) {
      void openVault(DEMO_ROOT);
      return;
    }
    if (requestedVault && requestedVault !== DEMO_ROOT) {
      void openVault(requestedVault);
      return;
    }
    let disposed = false;
    void loadRecentVaults().then(async (state) => {
      if (disposed) return;
      useAppStore.setState({ recentVaults: state.entries });
      if (state.last) {
        const root = await resolveRecentVault(state.last);
        if (!disposed && !getStore().vaultPath) await openVault(root);
      }
    }).catch(() => {
      if (!disposed) useAppStore.setState({ status: "Recent vaults could not be loaded. Select a vault folder to continue." });
    });
    return () => { disposed = true; };
  }, [openVault, mainWindow, requestedVault]);

  // Network/removable volumes do not reliably emit a browser-visible mount
  // event. Retry at a modest cadence while the unavailable screen is visible,
  // and immediately when the user returns to Mesa. The store's loading guard
  // prevents overlapping scans; a successful open clears unavailableVault and
  // tears this effect down.
  useEffect(() => {
    if (!mainWindow || vaultPath || !unavailableVault) return;
    if (unavailableVault.reason.includes("vault folder has not been selected in Mesa")) return;
    const retryUnavailableVault = () => {
      if (document.visibilityState !== "visible" || getStore().loading) return;
      void openVault(unavailableVault.root);
    };
    const timer = window.setInterval(retryUnavailableVault, 5_000);
    window.addEventListener("focus", retryUnavailableVault);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", retryUnavailableVault);
    };
  }, [openVault, unavailableVault, vaultPath, mainWindow]);

  useEffect(() => {
    if (
      !mainWindow ||
      !vaultPath ||
      !syncEnabled ||
      !syncToken ||
      syncPeerCount === 0 ||
      syncAutoMinutes <= 0
    )
      return;
    const baseDelayMs = autoSyncBaseDelayMs(syncAutoMinutes);
    let closed = false;
    let timeoutId: number | null = null;
    const schedule = (delayMs: number) => {
      timeoutId = window.setTimeout(async () => {
        const st = getStore();
        if (
          closed ||
          st.vaultPath !== vaultPath ||
          !st.settings.syncEnabled ||
          !st.settings.syncToken ||
          st.settings.peers.length === 0 ||
          st.settings.syncAutoMinutes <= 0
        ) {
          return;
        }
        if (!st.syncBusy) await st.syncAll();
        if (closed) return;
        const next = getStore();
        schedule(
          nextAutoSyncDelayMs(baseDelayMs, next.syncReport, next.syncBusy)
        );
      }, delayMs);
    };
    schedule(baseDelayMs);
    return () => {
      closed = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [
    mainWindow,
    vaultPath,
    syncEnabled,
    syncToken,
    syncPeerCount,
    syncAutoMinutes,
  ]);

  // Popped-out Tauri windows send a dock event back to the main window. The
  // sender owns closing itself; the main app only restores the view/context.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let alive = true;
    let unlistenDock: (() => void) | null = null;
    let unlistenAgent: (() => void) | null = null;
    void (async () => {
      const offDock = await listen(DOCK_WINDOW_EVENT, async (event) => {
        const payload = normalizeDockWindowPayload(event.payload);
        if (!payload) return;
        const st = getStore();
        if (payload.kind === "agent") {
          st.moveViewToRight("agent");
          const idx = getStore().settings.rightStack.indexOf("agent");
          getStore().setKeyboardFocus({ region: "right", rightIndex: Math.max(0, idx) });
          return;
        }
        if (payload.kind === "research") {
          st.openDeepResearch(true);
          return;
        }
        if (payload.kind === "doc") {
          await st.openFile(payload.relPath);
          st.moveViewToCenter("doc");
          st.setKeyboardFocus({ region: "center", rightIndex: st.keyboardFocus.rightIndex });
          return;
        }
        if (payload.relPath) await st.selectFile(payload.relPath);
        st.moveViewToRight(payload.view);
        const idx = getStore().settings.rightStack.indexOf(payload.view);
        getStore().setKeyboardFocus({ region: "right", rightIndex: Math.max(0, idx) });
      });
      const offAgent = await listen(GLOBAL_AGENT_EVENT, () => {
        const st = getStore();
        st.setPiOverlayOpen(!st.piOverlayOpen);
      });
      if (alive) {
        unlistenDock = offDock;
        unlistenAgent = offAgent;
      } else {
        offDock();
        offAgent();
      }
    })();
    return () => {
      alive = false;
      unlistenDock?.();
      unlistenAgent?.();
    };
  }, [mainWindow]);

  // Focus the main webview after its first paint so renderer shortcuts receive input.
  useEffect(() => {
    if (!mainWindow || !IN_TAURI) return;
    let disposed = false;
    let timer: number | undefined;
    const appRoot = appRootRef.current;
    const focusRenderer = () => {
      if (disposed) return;
      window.focus();
      appRoot?.focus({ preventScroll: true });
    };
    void Promise.all([
      import("@tauri-apps/api/window"),
      import("@tauri-apps/api/webview"),
    ]).then(async ([{ getCurrentWindow }, { getCurrentWebview }]) => {
      if (disposed) return;
      const currentWindow = getCurrentWindow();
      const currentWebview = getCurrentWebview();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      if (disposed) return;
      await currentWindow.setFocus().catch(() => undefined);
      await currentWebview.setFocus().catch(() => undefined);
      focusRenderer();
      // A cold macOS window can finish its native activation just after the
      // first renderer frame. One short retry covers that startup race without
      // stealing focus again during normal use.
      timer = window.setTimeout(() => {
        if (!disposed) {
          void currentWindow.setFocus().catch(() => undefined);
          void currentWebview.setFocus().catch(() => undefined);
          focusRenderer();
        }
      }, 80);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [mainWindow, appRootRef]);

  useEffect(() => {
    if (!mainWindow) return;
    const onShiftTabKey = (e: KeyboardEvent) => {
      if (!isPlainShiftTab(e)) return;
      // Shift+Tab remains ordinary backward focus navigation inside dialogs
      // and text controls. The overlay gesture is only owned by the app shell
      // when focus is in a workspace region.
      const active = document.activeElement as HTMLElement | null;
      if (isTextEntryTarget(active) || active?.closest('[role="dialog"], dialog')) return;
      if (claimPlainShiftTabToggle(e)) {
        getStore().toggleOverlay();
      }
      claimKeyboardShortcut(e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.code === "ShiftLeft") leftShiftDownRef.current = true;
      const el = document.activeElement as HTMLElement | null;
      const editable = isTextEntryTarget(el);
      const mod = isAppModifier(e);
      const k = e.key.toLowerCase();
      if (mod && k === "p") {
        e.preventDefault();
        getStore().setPalette(true);
        return;
      } else if (mod && e.shiftKey && k === "f") {
        e.preventDefault();
        getStore().openSearch("");
        return;
      } else if (mod && e.key === ",") {
        e.preventDefault();
        getStore().setSettingsOpen(true);
        return;
      } else if (!IN_TAURI && mod && leftShiftDownRef.current && e.code === "Space") {
        e.preventDefault();
        const st = getStore();
        st.setPiOverlayOpen(!st.piOverlayOpen);
        return;
      } else if (mod && k === "n") {
        e.preventDefault();
        void getStore().newNote();
        return;
      }

      if (editable) return;
      const st = getStore();
      const key = e.key;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && k === "w") {
        e.preventDefault();
        vimPrefixRef.current = "window";
        useAppStore.setState({
          status: "Window command: h/l focus, H/L move, j/k choose stacked panel, f flip side.",
        });
        return;
      }

      if (vimPrefixRef.current === "window") {
        e.preventDefault();
        vimPrefixRef.current = null;
        const stack = st.settings.rightStack;
        const focus = clampKeyboardFocus(st.keyboardFocus, stack.length);
        if (k === "q" || k === "c") {
          if (focus.region === "center") {
            st.closeCenter();
          } else if (focus.region === "right") {
            const view = stack[focus.rightIndex];
            if (view) st.removeViewFromWorkspace(view);
          }
          return;
        }
        if (k === "f") {
          st.flipDockSide();
          return;
        }
        if (k === "h" || k === "j" || k === "k" || k === "l") {
          if (e.shiftKey && k === "h" && focus.region === "right") {
            const view = stack[focus.rightIndex];
            if (view) st.moveViewToCenter(view);
            st.setKeyboardFocus({ region: "center", rightIndex: focus.rightIndex });
          } else if (
            e.shiftKey &&
            k === "l" &&
            focus.region === "center" &&
            st.settings.centerView !== "empty"
          ) {
            st.moveViewToRight(st.settings.centerView);
            st.setKeyboardFocus({ region: "right", rightIndex: stack.length });
          } else if (e.shiftKey && focus.region === "right" && (k === "j" || k === "k")) {
            const view = stack[focus.rightIndex];
            if (view) {
              const next = Math.max(
                0,
                Math.min(stack.length - 1, focus.rightIndex + (k === "j" ? 1 : -1))
              );
              st.moveViewToRight(view, next);
              st.setKeyboardFocus({ region: "right", rightIndex: next });
            }
          } else {
            st.setKeyboardFocus(
              moveKeyboardFocus(focus, k as "h" | "j" | "k" | "l", stack.length, st.settings.sidebarOpen)
            );
          }
        }
        return;
      }

      if (vimPrefixRef.current === "g") {
        vimPrefixRef.current = null;
        if (k === "g") {
          e.preventDefault();
          const ordered = keyboardFileOrder(st.files, st.notes, st.settings);
          const first = edgePath(ordered, "first");
          if (first) void st.selectFile(first);
          st.setKeyboardFocus({ ...st.keyboardFocus, region: "sidebar" });
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (k === "g") {
        e.preventDefault();
        vimPrefixRef.current = "g";
        useAppStore.setState({
          status: "g again jumps to the first file. Shift-G jumps to the last file.",
        });
        return;
      }
      if (key === "G") {
        e.preventDefault();
        const ordered = keyboardFileOrder(st.files, st.notes, st.settings);
        const last = edgePath(ordered, "last");
        if (last) void st.selectFile(last);
        st.setKeyboardFocus({ ...st.keyboardFocus, region: "sidebar" });
        return;
      }
      if (k === "j" || k === "k") {
        e.preventDefault();
        const focus = clampKeyboardFocus(
          st.keyboardFocus,
          st.settings.rightStack.length
        );
        if (focus.region === "right") {
          st.setKeyboardFocus(
            moveKeyboardFocus(
              focus,
              k as "j" | "k",
              st.settings.rightStack.length,
              st.settings.sidebarOpen
            )
          );
        } else {
          const ordered = keyboardFileOrder(st.files, st.notes, st.settings);
          const next = adjacentPath(ordered, st.activePath, k === "j" ? 1 : -1);
          if (next) void st.selectFile(next);
          st.setKeyboardFocus({ ...focus, region: "sidebar" });
        }
        return;
      }
      if (k === "h" || k === "l") {
        e.preventDefault();
        const focus = clampKeyboardFocus(
          st.keyboardFocus,
          st.settings.rightStack.length
        );
        const next = moveKeyboardFocus(
          focus,
          k as "h" | "l",
          st.settings.rightStack.length,
          st.settings.sidebarOpen
        );
        if (k === "h" && focus.region === "center" && !st.settings.sidebarOpen) {
          st.setSetting("sidebarOpen", true);
          st.setKeyboardFocus({ ...focus, region: "sidebar" });
        } else {
          st.setKeyboardFocus(next);
        }
        return;
      }
      if (k === "/") {
        e.preventDefault();
        st.openSearch("");
        return;
      }
      if (k === "p") {
        e.preventDefault();
        if (st.settings.centerView === "preview") {
          st.setKeyboardFocus({ region: "center", rightIndex: st.keyboardFocus.rightIndex });
        } else if (!st.settings.rightStack.includes("preview")) {
          st.togglePanel("preview");
          st.setKeyboardFocus({ region: "right", rightIndex: st.settings.rightStack.length });
        } else {
          st.setKeyboardFocus({
            region: "right",
            rightIndex: st.settings.rightStack.indexOf("preview"),
          });
        }
        return;
      }
      if (k === "t") {
        e.preventDefault();
        if (st.settings.centerView === "tasks") {
          st.setKeyboardFocus({ region: "center", rightIndex: st.keyboardFocus.rightIndex });
        } else if (!st.settings.rightStack.includes("tasks")) {
          st.togglePanel("tasks");
          st.setKeyboardFocus({ region: "right", rightIndex: st.settings.rightStack.length });
        } else {
          st.setKeyboardFocus({
            region: "right",
            rightIndex: st.settings.rightStack.indexOf("tasks"),
          });
        }
        return;
      }
      if (k === "v") {
        e.preventDefault();
        st.moveViewToCenter("doc");
        st.setKeyboardFocus({ region: "center", rightIndex: st.keyboardFocus.rightIndex });
        return;
      }
      if (k === "b") {
        e.preventDefault();
        st.setSetting("sidebarOpen", !st.settings.sidebarOpen);
        st.setKeyboardFocus({ region: st.settings.sidebarOpen ? "center" : "sidebar", rightIndex: 0 });
        return;
      }
      if (key === "Escape") {
        vimPrefixRef.current = null;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      notePlainShiftTabKeyUp(e);
      if (e.code === "ShiftLeft") leftShiftDownRef.current = false;
    };
    const onBlur = () => {
      resetPlainShiftTabChord();
      leftShiftDownRef.current = false;
    };
    window.addEventListener("keydown", onShiftTabKey, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onShiftTabKey, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [mainWindow]);
}
