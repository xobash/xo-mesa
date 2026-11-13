import { Modal } from "./components/Modal";
import { PI_MIN_WIDTH } from "./lib/agent";
import { confirmAction } from "./lib/confirmAction";
import type { BlockedClose } from "./lib/closeGuard";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useAppStore, getStore } from "./store";
import { IN_TAURI } from "./lib/vault";
import { TopBar } from "./components/TopBar";
import { FileTree } from "./components/FileTree";
import { TagList } from "./components/TagList";
import { BookmarksList } from "./components/BookmarksList";
import { StatusBar } from "./components/StatusBar";
import { TasksModal } from "./components/TasksModal";
import { Tour, HelpModal } from "./components/Guide";
import { DocumentView, DocPopoutModal } from "./components/DocumentView";
import { DropOverlay } from "./components/DropOverlay";
import { useApplyTheme } from "./components/useApplyTheme";
import { useTrayStatus } from "./components/useTrayStatus";
import { useCustomHotkeys } from "./components/useCustomHotkeys";
import { useBrowserKeyGuard } from "./components/useBrowserKeyGuard";
import { useMainWindowEffects } from "./components/useMainWindowEffects";
import type { RightPanel } from "./types";
import { consumeGraphWindowBootstrap } from "./lib/graphWindowBootstrap";
import {
  DEEP_RESEARCH_STATE_EVENT,
  DEEP_RESEARCH_STATE_REQUEST_EVENT,
} from "./lib/deepResearchWindow";
import { backgroundWork } from "./lib/backgroundWorkGovernor";
import { AgentWindows, EphemeralModals, GraphView, OverlayBoundary } from "./components/LazySurfaces";
import { AgentWindow, ResearchWindow } from "./components/DetachedWindows";
import { DragGhostLayer, PreviewLayer } from "./components/FloatingLayers";
import { SortMenu } from "./components/SortMenu";
import { Welcome } from "./components/Welcome";
import { CenterRegion } from "./components/CenterRegion";
import { RightStack } from "./components/RightStack";
import { PanelWindow } from "./components/PanelWindow";

const initialRouteParams = new URLSearchParams(location.search);
let graphWindowBootstrapped = false;
if (initialRouteParams.get("panel") === "graph") {
  const bootstrapKey = initialRouteParams.get("graphBootstrap");
  const snapshot = bootstrapKey ? consumeGraphWindowBootstrap(bootstrapKey, localStorage, initialRouteParams.get("vault") ?? undefined) : null;
  if (snapshot) {
    useAppStore.setState((state) => ({
      vaultPath: snapshot.vaultPath,
      vaultName: snapshot.vaultName,
      files: snapshot.files,
      notes: snapshot.notes,
      settings: { ...state.settings, ...snapshot.settings },
      loading: false,
      status: `${Object.keys(snapshot.notes).length} notes`,
    }));
    graphWindowBootstrapped = true;
  }
}

export default function App() {
  const [blockedClose, setBlockedClose] = useState<{ reason: unknown; resolve: (choice: "keep" | "discard") => void } | null>(null);
  const blockedCloseRef = useRef<Promise<"keep" | "discard"> | null>(null);
  const [copying, setCopying] = useState(false);
  const onBlocked = useCallback<BlockedClose>((reason) => {
    if (blockedCloseRef.current) return blockedCloseRef.current;
    const result = new Promise<"keep" | "discard">(resolve => setBlockedClose({ reason, resolve }));
    blockedCloseRef.current = result;
    void result.finally(() => { blockedCloseRef.current = null; });
    return result;
  }, []);
  const finishBlockedClose = (choice: "keep" | "discard") => { blockedClose?.resolve(choice); setBlockedClose(null); };
  useEffect(() => () => { blockedClose?.resolve("keep"); }, [blockedClose]);
  const savePendingCopies = async () => {
    setCopying(true);
    try {
      const root = getStore().vaultPath;
      if (!root) throw new Error("No vault is open.");
      const snapshots = getStore().pendingTextSaves();
      for (const snapshot of snapshots) {
        const saved = await invoke<boolean>("text_save_copy", { root, name: `${snapshot.target.name}-unsaved.${snapshot.target.ext}`, content: snapshot.content });
        if (!saved) return;
      }
      useAppStore.setState({ status: "Recovery copies saved. Vault edits remain pending; keep editing or close without saving." });
    } catch (reason) { useAppStore.setState({ status: `Could not save recovery copies: ${String(reason)}` }); }
    finally { setCopying(false); }
  };
  // A single capture-phase observer covers every current and future surface,
  // including detached controls. It changes only local admission of optional
  // work; it never records input or sends it anywhere.
  useEffect(() => {
    const key = () => backgroundWork.noteInteraction("typing");
    const wheel = () => backgroundWork.noteInteraction("scroll");
    const pointer = () => backgroundWork.noteInteraction("drag");
    const resize = () => backgroundWork.noteInteraction("resize");
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    window.addEventListener("scroll", wheel, { capture: true, passive: true });
    window.addEventListener("pointermove", pointer, { capture: true, passive: true });
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", wheel, true);
      window.removeEventListener("scroll", wheel, true);
      window.removeEventListener("pointermove", pointer, true);
      window.removeEventListener("resize", resize);
    };
  }, []);
  const routeParams = useMemo(() => new URLSearchParams(location.search), []);
  // A spawned document window carries ?doc in its URL → render the reader only.
  const docMode = useMemo(() => routeParams.has("doc"), [routeParams]);
  // A popped-out panel window carries ?panel=preview|graph|tasks|calendar.
  const panelMode = useMemo(() => {
    const p = routeParams.get("panel");
    return p === "preview" || p === "graph" || p === "tasks"
      ? (p as RightPanel)
      : null;
  }, [routeParams]);
  const agentMode = useMemo(() => routeParams.has("agent"), [routeParams]);
  const researchMode = useMemo(() => routeParams.has("research"), [routeParams]);
  const requestedVault = useMemo(() => routeParams.get("vault") ?? "", [routeParams]);

  // Transient state belongs to its view or an effect-owned subscription.
  const vaultPath = useAppStore((s) => s.vaultPath);
  const unavailableVault = useAppStore((s) => s.unavailableVault);
  const graphFull = useAppStore((s) => s.graphFull);
  const openVault = useAppStore((s) => s.openVault);
  const theme = useAppStore((s) => s.theme);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const animations = useAppStore((s) => s.settings.animations);
  const hardwareAccel = useAppStore((s) => s.settings.hardwareAccel);
  const sidebarOpen = useAppStore((s) => s.settings.sidebarOpen);
  const sidebarWidth = useAppStore((s) => s.settings.sidebarWidth);
  const sidebarAutoHide = useAppStore((s) => s.settings.sidebarAutoHide);
  const rightWidth = useAppStore((s) => s.settings.rightWidth);
  const rightStack = useAppStore((s) => s.settings.rightStack);
  const usableRightWidth = rightStack.includes("agent") ? Math.max(PI_MIN_WIDTH, rightWidth) : rightWidth;
  const dockSide = useAppStore((s) => s.settings.dockSide);
  const dragView = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const setSetting = useAppStore((s) => s.setSetting);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const mainWindow = !docMode && !panelMode && !agentMode && !researchMode;

  useApplyTheme(theme, uiStyle);
  useTrayStatus(IN_TAURI && mainWindow);
  useCustomHotkeys(mainWindow);
  useBrowserKeyGuard(mainWindow);

  // A native Deep Research window is a separate webview realm. The main
  // renderer remains the run owner and mirrors the serializable run snapshot
  // to any detached viewers; the detached window never starts a second Pi
  // session or mutates the run independently.
  useEffect(() => {
    if (researchMode || !IN_TAURI) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    const relayLabels = new Set<string>();
    void listen<{ label?: string }>(DEEP_RESEARCH_STATE_REQUEST_EVENT, (event) => {
      const label = event.payload?.label;
      if (!label) return;
      relayLabels.add(label);
      void emitTo(label, DEEP_RESEARCH_STATE_EVENT, getStore().deepResearch).catch(() => undefined);
    }).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    // Mirror run updates without re-rendering the shell for each progress patch.
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (state.deepResearch === prev.deepResearch) return;
      for (const label of relayLabels) {
        void emitTo(label, DEEP_RESEARCH_STATE_EVENT, state.deepResearch).catch(() => undefined);
      }
    });
    return () => {
      alive = false;
      unlisten?.();
      unsubscribe();
    };
  }, [researchMode]);
  useEffect(() => {
    document.documentElement.dataset.anim = animations ? "on" : "off";
  }, [animations]);
  useEffect(() => {
    document.documentElement.dataset.accel = hardwareAccel ? "on" : "off";
  }, [hardwareAccel]);

  // Blur/visibility are early flush signals. Browser beforeunload cannot wait
  // for asynchronous filesystem work, so the native close interceptor in
  // useMainWindowEffects is the authoritative desktop shutdown path.
  useEffect(() => {
    if (docMode) return;
    const flush = () => {
      void getStore().flushSave().catch(() => undefined);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [docMode]);

  useMainWindowEffects({
    mainWindow,
    vaultPath,
    unavailableVault,
    openVault,
    requestedVault,
    onBlocked,
    appRootRef,
  });

  if (docMode) return <DocumentView />;
  if (panelMode) return <PanelWindow kind={panelMode} graphWindowBootstrapped={graphWindowBootstrapped} />;
  if (agentMode) return <AgentWindow />;
  if (researchMode) return <ResearchWindow />;

  if (!vaultPath) {
    return (
      <Welcome
        onOpen={() => void openVault()}
        onRetry={() =>
          unavailableVault &&
          void openVault(
            unavailableVault.reason.includes("vault folder has not been selected in Mesa")
              ? undefined
              : unavailableVault.root,
          )
        }
        unavailableVault={unavailableVault}
      />
    );
  }

  const rightRegionOpen = rightStack.length > 0 || !!dragView || !!draggingFile;

  // Collapse / expand every folder in one click.
  const collapseAll = () => {
    const map: Record<string, boolean> = {};
    for (const f of getStore().files) {
      const parts = f.relPath.split("/");
      for (let i = 1; i < parts.length; i++) map[parts.slice(0, i).join("/")] = true;
    }
    setCollapsedFolders(map);
  };

  // Drag the pane borders to resize. Width is updated live on the element, then
  // committed to settings on release.
  const startResize = (side: "left" | "right", e: React.PointerEvent) => {
    e.preventDefault();
    const el = layoutRef.current;
    const startX = e.clientX;
    const startW = side === "left" ? sidebarWidth : usableRightWidth;
    const move = (ev: PointerEvent) => {
      if (!el) return;
      const dx = ev.clientX - startX;
      if (side === "left") {
        const w = Math.max(160, Math.min(520, startW + dx));
        el.style.setProperty("--sidebar-w", w + "px");
        el.style.setProperty("--sidebar-slot-w", w + "px");
        el.dataset.dragS = String(w);
      } else {
        // Dock resize: the splitter sits on the dock's outer edge, so the drag
        // sign flips with the dock side (drag toward the dock widens it).
        const sign = dockSide === "left" ? 1 : -1;
        const minRightWidth = rightStack.includes("agent") ? PI_MIN_WIDTH : 260;
        const w = Math.max(minRightWidth, Math.min(760, startW + sign * dx));
        el.style.setProperty("--right-w", w + "px");
        el.dataset.dragR = String(w);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (el?.dataset.dragS) {
        setSetting("sidebarWidth", Number(el.dataset.dragS));
        delete el.dataset.dragS;
      }
      if (el?.dataset.dragR) {
        setSetting("rightWidth", Number(el.dataset.dragR));
        delete el.dataset.dragR;
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={appRootRef} className="app" tabIndex={-1}>
      {blockedClose && <Modal title="Unsaved changes" onClose={() => { if (!copying) finishBlockedClose("keep"); }}>
        <h2>Changes could not be saved</h2>
        <p>{String(blockedClose.reason)}</p>
        <p>Your work is still open. Save PDFs from their editor, or save text copies outside this vault before closing.</p>
        <button className="btn" disabled={copying} onClick={() => finishBlockedClose("keep")}>Keep editing</button>
        <button className="btn" disabled={copying} onClick={() => { void savePendingCopies(); }}>Save copies…</button>
        <button className="btn" disabled={copying} onClick={() => { void confirmAction("Close without saving pending changes? Any write already in progress may still finish.", { okLabel: "Close without saving", cancelLabel: "Keep editing" }).then(confirmed => { if (confirmed) finishBlockedClose("discard"); }); }}>Close without saving</button>
      </Modal>}
      <TopBar />
      {graphFull ? (
        <div className="full-graph">
          <GraphView />
        </div>
      ) : (
        <div
          className={
            "layout" +
            (sidebarOpen && sidebarAutoHide ? " auto-hide" : "") +
            (sidebarOpen ? "" : " no-sidebar") +
            (rightRegionOpen ? "" : " no-right") +
            (dockSide === "left" && rightRegionOpen ? " dock-left" : "")
          }
          ref={layoutRef}
          style={
            {
              "--sidebar-w": sidebarWidth + "px",
              "--sidebar-slot-w": sidebarOpen && !sidebarAutoHide ? sidebarWidth + "px" : "0px",
              "--right-w": usableRightWidth + "px",
            } as React.CSSProperties
          }
        >
          {sidebarOpen && sidebarAutoHide && (
            <div className="sidebar-edge" aria-hidden="true" />
          )}
          <aside className="sidebar" aria-hidden={!sidebarOpen}>
            <div className="sidebar-header">
              <span>Notes</span>
              <div className="sidebar-header-tools">
                <button
                  className="sort-btn sidebar-new-btn"
                  onClick={() => void getStore().newNote()}
                  title="New note"
                  aria-label="New note"
                >
                  +
                </button>
                <button
                  className="sort-btn"
                  onClick={() => getStore().revealActiveFile()}
                  title="Reveal active file"
                  aria-label="Reveal active file"
                >
                  ⌖
                </button>
                <button
                  className="sort-btn"
                  onClick={collapseAll}
                  title="Collapse all folders"
                  aria-label="Collapse all folders"
                >
                  ⊟
                </button>
                <SortMenu />
              </div>
            </div>
            <button
              className="sidebar-recovery"
              onClick={() => getStore().openRecovery()}
              aria-label="Open deleted files"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
              </svg>
              Deleted files
            </button>
            <BookmarksList />
            <FileTree />
            <TagList />
          </aside>
          {sidebarOpen && !sidebarAutoHide && (
            <div
              className="splitter splitter-left"
              onPointerDown={(e) => startResize("left", e)}
            />
          )}
          <CenterRegion />
          {rightRegionOpen && (
            <div
              className="splitter splitter-right"
              onPointerDown={(e) => startResize("right", e)}
            />
          )}
          <RightStack />
        </div>
      )}
      <StatusBar />
      <EphemeralModals />
      <AgentWindows />
      <TasksModal />
      <HelpModal />
      <Tour />
      <DocPopoutModal />
      <DropOverlay />
      <PreviewLayer />
      <DragGhostLayer />
      <OverlayBoundary />
    </div>
  );
}
