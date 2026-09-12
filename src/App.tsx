import { installCloseGuard } from "./lib/closeGuard";
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { useAppStore, getStore, type VaultUnavailableState } from "./store";
import type { DeepResearchRunState } from "./store";
import { IN_TAURI, DEMO_ROOT, fileKind, isEditableTextExt } from "./lib/vault";
import { MediaView } from "./components/MediaView";
import { CodeView } from "./components/CodeView";
import { TopBar } from "./components/TopBar";
import { FileTree } from "./components/FileTree";
import { TagList } from "./components/TagList";
import { BookmarksList } from "./components/BookmarksList";
import { Preview } from "./components/Preview";
import { StatusBar } from "./components/StatusBar";
import { TasksModal, TasksPanel } from "./components/TasksModal";
import { Tour, HelpModal, hasToured } from "./components/Guide";
import { DocumentView, DocPopoutModal } from "./components/DocumentView";
import { DropOverlay } from "./components/DropOverlay";
import { PreviewCard } from "./components/PreviewCard";
import { startViewDrag } from "./components/panelDrag";
import { useApplyTheme } from "./components/useApplyTheme";
import { SORT_LABELS } from "./lib/sort";
import {
  adjacentPath,
  clampKeyboardFocus,
  edgePath,
  keyboardFileOrder,
  moveKeyboardFocus,
} from "./lib/keyboardNav";
import {
  DOCK_WINDOW_EVENT,
  GLOBAL_AGENT_EVENT,
  closeCurrentPopoutWindow,
  dockIntoMainWindow,
  installNativeDragDock,
  normalizeDockWindowPayload,
} from "./lib/windowDock";
import {
  claimPlainShiftTabToggle,
  claimKeyboardShortcut,
  isPlainShiftTab,
  isTextEntryTarget,
  isWindowTransferShortcut,
  notePlainShiftTabKeyUp,
  resetPlainShiftTabChord,
} from "./lib/shortcuts";
import type { SortMode, RightPanel, WorkspaceView } from "./types";
import { consumeGraphWindowBootstrap } from "./lib/graphWindowBootstrap";
import {
  AGENT_CONTEXT_EVENT,
  AGENT_WINDOW_READY_EVENT,
} from "./lib/piSessionBridge";
import {
  DEEP_RESEARCH_STATE_EVENT,
  DEEP_RESEARCH_STATE_REQUEST_EVENT,
} from "./lib/deepResearchWindow";
import { DeepResearchPhaseChipWithRun } from "./components/DeepResearchPhaseChip";
import {
  buildAgentContext,
  contextPrompt,
  type AgentContext,
} from "./lib/agent";
import {
  LatestWinsQueue,
  SupersededTaskError,
} from "./lib/latestWinsQueue";
import { backgroundWork } from "./lib/backgroundWorkGovernor";
import { nextAutoSyncDelayMs } from "./lib/syncAutoSchedule";

// The CodeMirror editor stack (~590 kB min across codemirror + @lezer) is the
// entry chunk's largest resident, and only the main window's DocPane ever
// renders it — popout windows (?doc / ?panel / ?agent) boot the same entry
// chunk and never mount the editor. Load it lazily so the shell (and every
// popout) parses half as much JS; same stance as the pdf-lib and xterm splits.
const Editor = lazy(() =>
  import("./components/Editor").then((m) => ({ default: m.Editor }))
);

// Graph is not part of the default Editor + Preview workspace, but its canvas
// renderer and d3-force stack were paid by every main/popout startup. Keep the
// same component boundary while loading it only when a graph surface mounts.
const LazyGraphView = lazy(() =>
  import("./components/GraphView").then((m) => ({ default: m.GraphView }))
);

const LazyAgentSurface = lazy(() =>
  import("./components/AgentPanel").then((m) => ({ default: m.AgentSurface }))
);
const LazyAgentPanel = lazy(() =>
  import("./components/AgentPanel").then((m) => ({ default: m.AgentPanel }))
);
const LazyAgentOverlay = lazy(() =>
  import("./components/AgentPanel").then((m) => ({ default: m.AgentOverlay }))
);
const LazyDeepResearchPanel = lazy(() =>
  import("./components/DeepResearchPanel").then((m) => ({ default: m.DeepResearchPanel }))
);
const LazyOverlay = lazy(() =>
  import("./components/Overlay").then((m) => ({ default: m.Overlay }))
);
const LazyCommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette }))
);
const LazySearchPanel = lazy(() =>
  import("./components/SearchPanel").then((m) => ({ default: m.SearchPanel }))
);
const LazySettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal }))
);
const LazyDiagnosticsModal = lazy(() =>
  import("./components/DiagnosticsModal").then((m) => ({ default: m.DiagnosticsModal }))
);
const LazySyncModal = lazy(() =>
  import("./components/SyncModal").then((m) => ({ default: m.SyncModal }))
);
// Only ever mounted behind `connectOpen`, so it does no work while closed and
// nothing but the welcome screen's "connect" button can reach it — 8.8 kB of
// pairing/discovery UI that the entry chunk was carrying for every launch.
const LazyConnectVaultModal = lazy(() =>
  import("./components/ConnectVaultModal").then((m) => ({
    default: m.ConnectVaultModal,
  }))
);

// Main-workspace context changes can be faster than Tauri IPC completion
// (e.g. keyboard navigation through notes). Serialize them and skip queued
// stale values so Rust's per-turn context can never settle on an older view.
const PI_CONTEXT_PUBLISH_QUEUE = new LatestWinsQueue<string, void>();

function GraphView() {
  return (
    <Suspense fallback={<div className="graph-wrap" aria-busy="true" />}>
      <LazyGraphView />
    </Suspense>
  );
}

function AgentSurface(props: React.ComponentProps<typeof LazyAgentSurface>) {
  return (
    <Suspense fallback={<div className="agent-surface" aria-busy="true" />}>
      <LazyAgentSurface {...props} />
    </Suspense>
  );
}

/** Closed Pi windows should not pull the terminal/harness surface tree into
 * startup. Their store flags already own visibility, so gate the lazy module
 * at the same boundary. */
function AgentWindows() {
  const agentOpen = useAppStore((s) => s.agentOpen);
  const piOverlayOpen = useAppStore((s) => s.piOverlayOpen);
  if (!agentOpen && !piOverlayOpen) return null;
  return (
    <Suspense fallback={null}>
      {agentOpen && <LazyAgentPanel />}
      {piOverlayOpen && <LazyAgentOverlay />}
    </Suspense>
  );
}

/** Load the Steam overlay only on first use, then keep it mounted forever so
 * Overlay's existing 240 ms close animation can finish after `open` flips. */
function OverlayBoundary() {
  const open = useAppStore((s) => s.overlayOpen);
  const [loaded, setLoaded] = useState(open);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  if (!loaded && !open) return null;
  return (
    <Suspense fallback={null}>
      <LazyOverlay />
    </Suspense>
  );
}

function EphemeralModals() {
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const diagnosticsOpen = useAppStore((s) => s.diagnosticsOpen);
  const syncOpen = useAppStore((s) => s.syncOpen);
  if (!paletteOpen && !searchOpen && !settingsOpen && !diagnosticsOpen && !syncOpen) return null;
  return (
    <Suspense fallback={null}>
      {paletteOpen && <LazyCommandPalette />}
      {searchOpen && <LazySearchPanel />}
      {settingsOpen && <LazySettingsModal />}
      {diagnosticsOpen && <LazyDiagnosticsModal />}
      {syncOpen && <LazySyncModal />}
    </Suspense>
  );
}

const initialRouteParams = new URLSearchParams(location.search);
let graphWindowBootstrapped = false;
if (initialRouteParams.get("panel") === "graph") {
  const bootstrapKey = initialRouteParams.get("graphBootstrap");
  const snapshot = bootstrapKey ? consumeGraphWindowBootstrap(bootstrapKey) : null;
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

/** The document editor stack (tabs + editor / code / media), usable in either
 *  layout region so the editor can be swapped between center and right. */
function DocPane() {
  const activePath = useAppStore((s) => s.activePath);
  // Resolve the active file through the store index instead of subscribing to
  // the whole `files` array and scanning it. Only `ext` is read below, so this
  // also stops the editor stack re-rendering for vault-wide array replacements
  // (deferred metadata hydration, watcher batches) that left this file alone.
  const activeFile = useAppStore((s) =>
    s.activePath ? s.fileFor(s.activePath) : undefined
  );
  const kind = activeFile ? fileKind(activeFile.ext) : "text";
  const editable = !activeFile || isEditableTextExt(activeFile.ext);
  return (
    <>
      <Tabs />
      {kind === "text" ? (
        editable ? (
          // The fallback mirrors the editor's wrapper so the pane doesn't
          // jump during the (local, ~ms) lazy-chunk load.
          <Suspense fallback={<div className="editor-wrap" />}>
            <Editor />
          </Suspense>
        ) : (
          <CodeView rel={activePath!} />
        )
      ) : activePath ? (
        <MediaView rel={activePath!} />
      ) : (
        <div className="editor-empty">Open a note to begin.</div>
      )}
    </>
  );
}

function panelContent(kind: RightPanel) {
  if (kind === "preview") return <Preview />;
  if (kind === "graph") return <GraphView />;
  return <TasksPanel />;
}

function viewContent(
  kind: WorkspaceView,
  agentProps: Partial<React.ComponentProps<typeof LazyAgentSurface>> = {}
) {
  if (kind === "empty") {
    return (
      <div className="editor-empty">
        Open a file, drag a view here, or use Preview · Graph · Tasks.
      </div>
    );
  }
  if (kind === "doc") return <DocPane />;
  if (kind === "agent") return <AgentSurface embedded {...agentProps} />;
  return panelContent(kind);
}

const VIEW_LABEL: Record<WorkspaceView, string> = {
  empty: "Workspace",
  doc: "Editor",
  agent: "Pi",
  preview: "Preview",
  graph: "Graph",
  tasks: "Tasks",
};

function handleWorkspacePiTearOff(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return;
  if (!isWindowTransferShortcut(event)) return;
  claimKeyboardShortcut(event.nativeEvent);
  void getStore().openAgentWindow().then((opened) => {
    if (opened) getStore().removeViewFromWorkspace("agent");
  });
}

/** The right region: a vertical stack of panels (any number visible at once),
 *  each with a header (drag to reorder / edge-tear-off, × to close) and resizable
 *  dividers. Panels are added/removed from the top bar or by dragging here. */
function RightStack() {
  const stack = useAppStore((s) => s.settings.rightStack);
  const drag = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const keyboardFocus = useAppStore((s) => s.keyboardFocus);
  const removeViewFromWorkspace = useAppStore((s) => s.removeViewFromWorkspace);
  const ref = useRef<HTMLElement | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({});

  const startStackResize = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const section = ref.current;
    if (!section) return;
    const above = stack[i - 1];
    const below = stack[i];
    const h = section.clientHeight || 1;
    const wa = weights[above] ?? 1;
    const wb = weights[below] ?? 1;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      const frac = ((ev.clientY - startY) / h) * stack.length;
      setWeights((w) => ({
        ...w,
        [above]: Math.max(0.25, wa + frac),
        [below]: Math.max(0.25, wb - frac),
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section
      ref={ref}
      className={
        "right-stack" +
        (drag || draggingFile ? " drop-target" : "") +
        (keyboardFocus.region === "right" ? " kbd-focus" : "") +
        (stack.length === 0 ? " empty" : "")
      }
      data-region="right"
    >
      {stack.length === 0 && (
        <div className="stack-empty">
          Drag the editor or a panel here, or use the top bar — Preview · Graph · Tasks.
        </div>
      )}
      {stack.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && (
            <div
              className="stack-divider"
              onPointerDown={(e) => startStackResize(i, e)}
            />
          )}
          <div
            className="stack-pane"
            data-stack-index={i}
            style={{ flexGrow: weights[p] ?? 1 }}
          >
            {p !== "agent" && (
              <div
                className={
                  "stack-head" +
                  (keyboardFocus.region === "right" && keyboardFocus.rightIndex === i
                    ? " kbd-focus"
                    : "")
                }
                onPointerDown={(e) => startViewDrag(p, "stack", e)}
                title="Drag to reorder · drag out to pop into a window"
              >
                <span className="region-grip" aria-hidden="true">⠿</span>
                <span className="stack-title">{VIEW_LABEL[p]}</span>
                <button
                  className="stack-btn"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => removeViewFromWorkspace(p)}
                  title={`Close ${VIEW_LABEL[p]} view`}
                  aria-label={`Close ${VIEW_LABEL[p]} view`}
                >
                  ×
                </button>
              </div>
            )}
            <div className="stack-body">
              {viewContent(
                p,
                p === "agent"
                  ? {
                      windowTitle: "Pi agent",
                      onTitleBarPointerDown: (event) => startViewDrag("agent", "stack", event),
                      onTitleBarKeyDown: handleWorkspacePiTearOff,
                      titleBarHint: "Drag to move or separate · Ctrl/Cmd+Shift+Enter separates",
                      onClose: () => removeViewFromWorkspace("agent"),
                    }
                  : undefined
              )}
            </div>
          </div>
        </Fragment>
      ))}
      {drag ? (
        <div className="region-drop-hint">Drop {VIEW_LABEL[drag.view]} here</div>
      ) : draggingFile ? (
        <div className="region-drop-hint">Open file here</div>
      ) : null}
    </section>
  );
}

function CenterRegion() {
  const centerView = useAppStore((s) => s.settings.centerView);
  const drag = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const keyboardFocus = useAppStore((s) => s.keyboardFocus);
  const closeCenter = useAppStore((s) => s.closeCenter);

  return (
    <main
      className={
        "center" +
        (drag || draggingFile ? " drop-target" : "") +
        (keyboardFocus.region === "center" ? " kbd-focus" : "")
      }
      data-region="center"
    >
      {centerView !== "agent" && <div
        className={"center-head" + (centerView === "empty" ? " empty" : "")}
        onPointerDown={(e) => {
          if (centerView !== "empty") startViewDrag(centerView, "center", e);
        }}
        title={
          centerView === "empty"
            ? "Center is empty"
            : "Drag to swap this view with the right side"
        }
      >
        <span className="region-grip" aria-hidden="true">
          ⠿
        </span>
        <span className="stack-title">{VIEW_LABEL[centerView]}</span>
        {centerView !== "empty" && (
          <button
            className="stack-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={closeCenter}
            title={`Close ${VIEW_LABEL[centerView]} view`}
            aria-label={`Close ${VIEW_LABEL[centerView]} view`}
          >
            ×
          </button>
        )}
      </div>}
      <div className="center-body">
        {viewContent(
          centerView,
          centerView === "agent"
            ? {
                windowTitle: "Pi agent",
                onTitleBarPointerDown: (event) => startViewDrag("agent", "center", event),
                onTitleBarKeyDown: handleWorkspacePiTearOff,
                titleBarHint: "Drag to move or separate · Ctrl/Cmd+Shift+Enter separates",
                onClose: closeCenter,
              }
            : undefined
        )}
      </div>
      {drag ? (
        <div className="region-drop-hint">Drop {VIEW_LABEL[drag.view]} here</div>
      ) : draggingFile ? (
        <div className="region-drop-hint">Open file here</div>
      ) : null}
    </main>
  );
}

/** A panel rendered standalone in its own OS window (?panel=…). */
function PanelWindow({ kind }: { kind: RightPanel }) {
  const routeParams = useMemo(() => new URLSearchParams(location.search), []);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const selectFile = useAppStore((s) => s.selectFile);
  const openVault = useAppStore((s) => s.openVault);
  // The note this panel should follow (so a popped-out Preview shows the SAME
  // document as the pane it came from), passed as ?sel= in the URL.
  const sel = routeParams.get("sel");
  const requestedVault = routeParams.get("vault");
  useEffect(() => {
    if (vaultPath && sel) void selectFile(sel);
  }, [vaultPath, sel, selectFile]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void installNativeDragDock({
      kind: "panel",
      view: kind,
      relPath: activePath ?? sel,
    })
      .then((cleanup) => (dispose = cleanup))
      .catch((error) => console.warn("[mesa] native panel docking unavailable:", error));
    return () => dispose?.();
  }, [kind, activePath, sel]);
  useEffect(() => {
    if (!graphWindowBootstrapped || !requestedVault) return;
    const refresh = () => void openVault(requestedVault);
    const id = window.setTimeout(refresh, 1200);
    return () => window.clearTimeout(id);
  }, [requestedVault, openVault]);

  // Graph fills the native window. Drag its OS title bar over Mesa to dock it.
  if (kind === "graph") {
    return (
      <div className="panel-window panel-window-chromeless">
        <div className="panel-window-body">
          {vaultPath ? panelContent(kind) : <div className="editor-empty">Loading…</div>}
        </div>
      </div>
    );
  }

  const title = kind[0].toUpperCase() + kind.slice(1);
  return (
    <div className="panel-window">
      <header className="doc-window-bar">
        <span>{title}</span>
        <div className="dock-actions">
          <button
            className="dock-btn"
            onClick={() =>
              void dockIntoMainWindow({
                kind: "panel",
                view: kind,
                relPath: activePath ?? sel,
              })
            }
          >
            Dock
          </button>
          <button
            className="icon-btn"
            onClick={() => void closeCurrentPopoutWindow()}
            aria-label={`Close ${title} window`}
          >
            ×
          </button>
        </div>
      </header>
      <div className="panel-window-body">
        {vaultPath ? (
          panelContent(kind)
        ) : (
          <div className="editor-empty">Loading…</div>
        )}
      </div>
    </div>
  );
}

function AgentWindow() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const selectFile = useAppStore((s) => s.selectFile);
  const routeParams = useMemo(() => new URLSearchParams(location.search), []);
  const sel = routeParams.get("sel");
  const requestedVault = routeParams.get("vault") ?? "";
  // The detached realm opens and scans the vault in the background, but PTY
  // adoption must not wait for that potentially expensive scan. The launch
  // URL came from the already-open main vault and is sufficient to bind the
  // complete AgentSurface to the existing backend session immediately.
  const agentVaultPath = vaultPath || requestedVault;
  const agentLabel = routeParams.get("agentLabel") ?? "";
  const titleOverlay = routeParams.get("titleOverlay") === "1";
  const [contextOverride, setContextOverride] = useState<AgentContext | null>(null);
  // The live Pi session id handed off by the window this was popped out
  // from (see `openAgentWindow` in store.ts). This window is a separate
  // Tauri WebviewWindow/JS realm, so without carrying this across explicitly
  // AgentSurface has no way to know a `pi` process is already running for
  // this vault and would spawn a second, contextless one.
  const attachSessionId = routeParams.get("piSession");
  const announceReady = useCallback(
    async (sessionId: string) => {
      if (!agentLabel) return;
      await emit(AGENT_WINDOW_READY_EVENT, {
        label: agentLabel,
        sessionId,
      }).catch((error) => {
        console.warn("[mesa] detached Pi ready acknowledgement failed:", error);
      });
    },
    [agentLabel]
  );
  useEffect(() => {
    if (vaultPath && sel) void selectFile(sel);
  }, [vaultPath, sel, selectFile]);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void listen<AgentContext>(AGENT_CONTEXT_EVENT, (event) => {
      if (alive && event.payload && typeof event.payload === "object") {
        setContextOverride(event.payload);
      }
    }).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  const dockAgentWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (!isWindowTransferShortcut(event)) return;
    claimKeyboardShortcut(event.nativeEvent);
    void dockIntoMainWindow({ kind: "agent" });
  };
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void installNativeDragDock(
      { kind: "agent" },
      { requireUserDragArm: true }
    )
      .then((cleanup) => (dispose = cleanup))
      .catch((error) => console.warn("[mesa] native Pi docking unavailable:", error));
    return () => dispose?.();
  }, []);

  return (
    <div className={"agent-window" + (titleOverlay ? " titlebar-overlay" : "")}>
      {agentVaultPath ? (
        <AgentSurface
          embedded
          attachSessionId={attachSessionId}
          vaultPathOverride={agentVaultPath}
          contextOverride={contextOverride}
          windowTitle="Pi agent"
          nativeDragRegion
          onTitleBarKeyDown={dockAgentWithKeyboard}
          titleBarHint="Drag over Mesa or press Ctrl/Cmd+Shift+Enter to dock"
          onSessionReady={announceReady}
          onClose={() => void closeCurrentPopoutWindow()}
        />
      ) : (
        <div className="editor-empty">Loading Pi session…</div>
      )}
    </div>
  );
}

function ResearchWindow() {
  const routeParams = useMemo(() => new URLSearchParams(location.search), []);
  const requestedVault = routeParams.get("vault") ?? "";
  const researchLabel = routeParams.get("researchLabel") ?? "";
  const localRun = useAppStore((s) => s.deepResearch);
  const [remoteRun, setRemoteRun] = useState<DeepResearchRunState | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const off = await listen<DeepResearchRunState>(DEEP_RESEARCH_STATE_EVENT, (event) => {
        if (alive && event.payload && typeof event.payload === "object") {
          setRemoteRun(event.payload);
        }
      });
      if (!alive) {
        off();
        return;
      }
      unlisten = off;
      await emit(DEEP_RESEARCH_STATE_REQUEST_EVENT, { label: researchLabel });
    })().catch((error) => {
      if (alive) console.warn("[mesa] detached Deep Research state relay failed:", error);
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [researchLabel]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void installNativeDragDock({ kind: "research" }, { requireUserDragArm: true })
      .then((cleanup) => (dispose = cleanup))
      .catch((error) => console.warn("[mesa] native Deep Research docking unavailable:", error));
    return () => dispose?.();
  }, []);

  const dockResearchWithKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (!isWindowTransferShortcut(event)) return;
    claimKeyboardShortcut(event.nativeEvent);
    void dockIntoMainWindow({ kind: "research" });
  };

  return (
    <div className="research-window">
      <header
        className="doc-window-bar"
        data-tauri-drag-region=""
        tabIndex={0}
        aria-label="Deep Research window. Drag over Mesa or press Control or Command plus Shift plus Enter to dock."
        title="Drag over Mesa · Ctrl/Cmd+Shift+Enter docks"
        onKeyDown={dockResearchWithKeyboard}
      >
        <span data-tauri-drag-region="">Deep Research</span>
        <DeepResearchPhaseChipWithRun runOverride={remoteRun ?? localRun} />
        <span className="research-window-hint">Drag over Mesa · Ctrl/Cmd+Shift+Enter docks</span>
        <button className="icon-btn" onClick={() => void closeCurrentPopoutWindow()} aria-label="Close Deep Research window">
          ×
        </button>
      </header>
      <div className="research-window-body">
        {requestedVault || remoteRun ? (
          <Suspense fallback={<div className="editor-empty">Loading Deep Research…</div>}>
            <LazyDeepResearchPanel runOverride={remoteRun ?? localRun} readOnly />
          </Suspense>
        ) : (
          <div className="editor-empty">Waiting for the active Deep Research run…</div>
        )}
      </div>
    </div>
  );
}

/** Single floating preview card for sidebar files/folders and tag chips. */
function PreviewLayer() {
  const preview = useAppStore((s) => s.hoverPreview);
  if (!preview) return null;
  return (
    <div className="preview-layer">
      <PreviewCard target={preview.target} x={preview.x} y={preview.y} fixed />
    </div>
  );
}

function DragGhostLayer() {
  const ghost = useAppStore((s) => s.dragGhost);
  if (!ghost) return null;
  return (
    <div
      className={"drag-ghost " + ghost.kind}
      style={{ transform: `translate3d(${ghost.x + 14}px, ${ghost.y + 14}px, 0)` }}
    >
      {ghost.kind === "file" ? "File" : "Move"} · {ghost.label}
    </div>
  );
}

function Tabs() {
  const enableTabs = useAppStore((s) => s.settings.enableTabs);
  const openTabs = useAppStore((s) => s.openTabs);
  const activePath = useAppStore((s) => s.activePath);
  const notes = useAppStore((s) => s.notes);
  const selectFile = useAppStore((s) => s.selectFile);
  const closeTab = useAppStore((s) => s.closeTab);
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  const fileFor = useAppStore((s) => s.fileFor);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Keep the active tab scrolled into view when it changes.
  useEffect(() => {
    if (!enableTabs) return;
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [enableTabs, openTabs, activePath]);

  // Close the overflow menu on an outside click.
  useEffect(() => {
    if (!enableTabs || !menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [enableTabs, menuOpen]);

  // Pointer-based drag (NOT html5 draggable, which would trigger Tauri's native
  // file-drop overlay). Drag a tab out of the strip → pop it into its own window.
  const onTabPointerDown = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return; // left button only; middle-click closes (onAuxClick)
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6)
        moved = true;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const strip = stripRef.current;
      if (moved && strip) {
        const r = strip.getBoundingClientRect();
        const outside =
          ev.clientY > r.bottom + 20 ||
          ev.clientY < r.top - 20 ||
          ev.clientX < r.left - 20 ||
          ev.clientX > r.right + 20;
        if (outside) {
          void openDocWindow(id);
          closeTab(id);
          return;
        }
      }
      void selectFile(id); // click or in-strip drag → just select
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const title = (id: string) => notes[id]?.title ?? fileFor(id)?.name ?? id;

  if (!enableTabs) return null;

  if (openTabs.length === 0)
    return (
      <div className="tabs-wrap empty">
        <div className="tabs" ref={stripRef} />
      </div>
    );

  return (
    <div className="tabs-wrap">
      <div className="tabs" ref={stripRef}>
        {openTabs.map((id) => (
          <div
            key={id}
            ref={id === activePath ? activeTabRef : undefined}
            className={"tab" + (id === activePath ? " active" : "")}
            onPointerDown={(e) => onTabPointerDown(id, e)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(id);
              }
            }}
            title="Drag out to open in its own window · middle-click to close"
          >
            <span className="tab-title">{title(id)}</span>
            <button
              className="tab-close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
              title="Close"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="tab-overflow" ref={menuRef}>
        <button
          className="tab-overflow-btn"
          onClick={() => setMenuOpen((v) => !v)}
          title="All open tabs"
          aria-label="All open tabs"
        >
          ▾
        </button>
        {menuOpen && (
          <div className="tab-menu">
            {openTabs.map((id) => (
              <div
                key={id}
                className={"tab-menu-item" + (id === activePath ? " active" : "")}
              >
                <button
                  className="tab-menu-pick"
                  onClick={() => {
                    setMenuOpen(false);
                    void selectFile(id);
                  }}
                >
                  {title(id)}
                </button>
                <button
                  className="tab-menu-close"
                  onClick={() => closeTab(id)}
                  title="Close"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SortMenu() {
  const sortMode = useAppStore((s) => s.settings.sortMode);
  const sortDir = useAppStore((s) => s.settings.sortDir);
  const typeFilter = useAppStore((s) => s.settings.typeFilter);
  const files = useAppStore((s) => s.files);
  const setSetting = useAppStore((s) => s.setSetting);
  const [open, setOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const presentTypes = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) set.add(f.ext.toLowerCase());
    return [...set].sort();
  }, [files]);

  const modes: SortMode[] = ["name", "modified", "size", "links", "type"];
  const active = typeFilter !== "all";
  return (
    <div className="sort-menu" ref={ref}>
      <button
        className={"sort-btn" + (active ? " on" : "")}
        onClick={() => setOpen((v) => !v)}
        title={"Sort: " + SORT_LABELS[sortMode]}
      >
        ⇅
      </button>
      {open && (
        <div className="theme-pop sort-pop">
          <div className="sort-pop-label">Sort by</div>
          {modes.map((m) => (
            <button
              key={m}
              className={"theme-opt" + (m === sortMode ? " on" : "")}
              onClick={() => setSetting("sortMode", m)}
            >
              {SORT_LABELS[m]}
            </button>
          ))}
          <div className="sort-pop-row">
            <button
              className={"seg-btn" + (sortDir === "asc" ? " on" : "")}
              onClick={() => setSetting("sortDir", "asc")}
              title="Ascending / natural order"
            >
              ↑ Asc
            </button>
            <button
              className={"seg-btn" + (sortDir === "desc" ? " on" : "")}
              onClick={() => setSetting("sortDir", "desc")}
              title="Descending / reversed"
            >
              ↓ Desc
            </button>
          </div>
          <button
            className="theme-opt sort-accordion"
            onClick={() => setTypeOpen((v) => !v)}
            aria-expanded={typeOpen}
          >
            <span className={"tag-caret" + (typeOpen ? "" : " collapsed")}>▾</span>
            File type
            <span className="sort-type-current">
              {typeFilter === "all" ? "All" : "." + typeFilter}
            </span>
          </button>
          {typeOpen && (
            <div className="sort-type-list">
              <button
                className={"theme-opt" + (typeFilter === "all" ? " on" : "")}
                onClick={() => setSetting("typeFilter", "all")}
              >
                All types
              </button>
              {presentTypes.map((t) => (
                <button
                  key={t}
                  className={"theme-opt" + (typeFilter === t ? " on" : "")}
                  onClick={() => setSetting("typeFilter", t)}
                >
                  .{t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Welcome({
  onOpen,
  onRetry,
  loading,
  status,
  unavailableVault,
}: {
  onOpen: () => void;
  onRetry: () => void;
  loading: boolean;
  status: string;
  unavailableVault: VaultUnavailableState | null;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark">✦</div>
        <h1>Mesa</h1>
        <p>
          A local-first vault workspace with a living graph, snap-in views,
          saved webpage rendering, Shift+Tab tools, and a Pi terminal that
          starts with path-only context.
        </p>
        {unavailableVault && (
          <div className="welcome-unavailable" role="alert">
            <strong>{unavailableVault.name} is not connected</strong>
            <span>
              Mesa kept this vault selected and did not open it as an empty
              workspace. Reconnect the drive; Mesa retries automatically while
              this window is open.
            </span>
            <code title={unavailableVault.reason}>{unavailableVault.root}</code>
          </div>
        )}
        <div className="welcome-actions">
          {unavailableVault && (
            <button className="btn primary" onClick={onRetry} disabled={loading}>
              {loading ? "Retrying…" : "Retry now"}
            </button>
          )}
          <button className={"btn " + (unavailableVault ? "welcome-secondary" : "primary")} onClick={onOpen} disabled={loading}>
            {unavailableVault ? "Choose another vault" : loading ? "Opening…" : "Open vault folder"}
          </button>
          {IN_TAURI && (
            <button
              className="btn welcome-secondary"
              onClick={() => setConnectOpen(true)}
              disabled={loading}
            >
              Open a shared vault
            </button>
          )}
        </div>
        {loading && (
          <div className="welcome-progress" role="status" aria-live="polite">
            <span className="welcome-progress-dot" aria-hidden="true" />
            <span>{status || "Getting things ready…"}</span>
          </div>
        )}
        {IN_TAURI && (
          <p className="welcome-hint">
            Pick any folder for a new vault, or pull one from another device
            that's sharing it. Notes are plain <code>.md</code> files.
          </p>
        )}
      </div>
      <Suspense fallback={null}>
        {connectOpen && (
          <LazyConnectVaultModal onClose={() => setConnectOpen(false)} />
        )}
      </Suspense>
    </div>
  );
}

export default function App() {
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

  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const unavailableVault = useAppStore((s) => s.unavailableVault);
  const activePath = useAppStore((s) => s.activePath);
  const openTabs = useAppStore((s) => s.openTabs);
  const settings = useAppStore((s) => s.settings);
  const files = useAppStore((s) => s.files);
  const graphFull = useAppStore((s) => s.graphFull);
  const loading = useAppStore((s) => s.loading);
  const status = useAppStore((s) => s.status);
  const openVault = useAppStore((s) => s.openVault);
  const theme = useAppStore((s) => s.theme);
  const animations = useAppStore((s) => s.settings.animations);
  const hardwareAccel = useAppStore((s) => s.settings.hardwareAccel);
  const sidebarOpen = useAppStore((s) => s.settings.sidebarOpen);
  const sidebarWidth = useAppStore((s) => s.settings.sidebarWidth);
  const sidebarAutoHide = useAppStore((s) => s.settings.sidebarAutoHide);
  const rightWidth = useAppStore((s) => s.settings.rightWidth);
  const rightStack = useAppStore((s) => s.settings.rightStack);
  const usableRightWidth = rightStack.includes("agent") ? Math.max(420, rightWidth) : rightWidth;
  const dockSide = useAppStore((s) => s.settings.dockSide);
  const dragView = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const syncAutoMinutes = useAppStore((s) => s.settings.syncAutoMinutes);
  const syncEnabled = useAppStore((s) => s.settings.syncEnabled);
  const syncPeerCount = useAppStore((s) => s.settings.peers.length);
  const syncToken = useAppStore((s) => s.settings.syncToken);
  const deepResearch = useAppStore((s) => s.deepResearch);
  const setSetting = useAppStore((s) => s.setSetting);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const vimPrefixRef = useRef<"g" | "window" | null>(null);
  const leftShiftDownRef = useRef(false);
  const researchRelayLabelsRef = useRef<Set<string>>(new Set());

  useApplyTheme(theme);

  // A native Deep Research window is a separate webview realm. The main
  // renderer remains the run owner and mirrors the serializable run snapshot
  // to any detached viewers; the detached window never starts a second Pi
  // session or mutates the run independently.
  useEffect(() => {
    if (researchMode || !IN_TAURI) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void listen<{ label?: string }>(DEEP_RESEARCH_STATE_REQUEST_EVENT, (event) => {
      const label = event.payload?.label;
      if (!label) return;
      researchRelayLabelsRef.current.add(label);
      void emitTo(label, DEEP_RESEARCH_STATE_EVENT, getStore().deepResearch).catch(() => undefined);
    }).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [researchMode]);
  useEffect(() => {
    if (researchMode || !IN_TAURI) return;
    for (const label of researchRelayLabelsRef.current) {
      void emitTo(label, DEEP_RESEARCH_STATE_EVENT, deepResearch).catch(() => undefined);
    }
  }, [deepResearch, researchMode]);
  useEffect(() => {
    document.documentElement.dataset.anim = animations ? "on" : "off";
  }, [animations]);
  useEffect(() => {
    document.documentElement.dataset.accel = hardwareAccel ? "on" : "off";
  }, [hardwareAccel]);

  // Keep the one external Pi process and every detached AgentSurface aligned
  // with what the MAIN Mesa workspace is showing. Process env/startup args are
  // immutable, so Rust stores this path-only context for mesa-context.ts to
  // inject before each turn; detached webviews receive the same typed payload
  // for their visible context strip. Popout realms never publish their stale
  // launch-time store back over the main workspace.
  const liveAgentContext = useMemo(
    () =>
      buildAgentContext({
        vaultName,
        vaultPath,
        activePath,
        openTabs,
        settings,
      }),
    [vaultName, vaultPath, activePath, openTabs, settings]
  );
  const liveAgentContextText = useMemo(
    () => contextPrompt(liveAgentContext),
    [liveAgentContext]
  );
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
    const context = vaultPath ? liveAgentContextText : "";
    void PI_CONTEXT_PUBLISH_QUEUE.enqueue(context, async () => {
      await invoke("activity_set_context", { context });
      if (vaultPath) await emit(AGENT_CONTEXT_EVENT, liveAgentContext);
    }).catch((error) => {
      if (!(error instanceof SupersededTaskError)) {
        console.warn("[mesa] Pi context publish failed:", error);
      }
    });
  }, [
    docMode,
    panelMode,
    agentMode,
    vaultPath,
    liveAgentContext,
    liveAgentContextText,
  ]);

  // First-run guided tour, once the vault is open.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !vaultPath || hasToured()) return;
    const t = setTimeout(() => getStore().setTourOpen(true), 450);
    return () => clearTimeout(t);
  }, [vaultPath, docMode, panelMode, agentMode, researchMode]);

  // Blur/visibility are early flush signals. Browser beforeunload cannot wait
  // for asynchronous filesystem work, so the native close interceptor below
  // is the authoritative desktop shutdown path.
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

  // Tauri close requests are cancellable. Hold the main window open until all
  // dirty paths finish verified writes; a failed save leaves the window and
  // editor intact so the user can resolve the reported conflict.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      stop = installCloseGuard(
        getCurrentWindow(),
        () => getStore().flushSave(),
        () => getStore().textSaveState.pending > 0,
        (status) => useAppStore.setState({ status })
      );
    }).catch((error) => {
      if (!disposed) useAppStore.setState({ status: `Close safety failed to start: ${String(error)}` });
    });
    return () => { disposed = true; stop?.(); };
  }, [docMode, panelMode, agentMode, researchMode]);

  // Auto-open: demo vault in the browser, last-used vault in the desktop app.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || useAppStore.getState().vaultPath) return;
    if (!IN_TAURI) {
      void openVault(DEMO_ROOT);
      return;
    }
    if (requestedVault && requestedVault !== DEMO_ROOT) {
      void openVault(requestedVault);
      return;
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem("mesa:lastVault");
    } catch {
      /* ignore */
    }
    if (last && last !== DEMO_ROOT) void openVault(last);
  }, [openVault, docMode, panelMode, agentMode, researchMode, requestedVault]);

  // Network/removable volumes do not reliably emit a browser-visible mount
  // event. Retry at a modest cadence while the unavailable screen is visible,
  // and immediately when the user returns to Mesa. The store's loading guard
  // prevents overlapping scans; a successful open clears unavailableVault and
  // tears this effect down.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || vaultPath || !unavailableVault) return;
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
  }, [openVault, unavailableVault, vaultPath, docMode, panelMode, agentMode, researchMode]);

  useEffect(() => {
    if (
      docMode ||
      panelMode ||
      agentMode ||
      researchMode ||
      !vaultPath ||
      !syncEnabled ||
      !syncToken ||
      syncPeerCount === 0 ||
      syncAutoMinutes <= 0
    )
      return;
    const baseDelayMs = Math.max(1, syncAutoMinutes) * 60_000;
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
    docMode,
    panelMode,
    agentMode,
    researchMode,
    vaultPath,
    syncEnabled,
    syncToken,
    syncPeerCount,
    syncAutoMinutes,
  ]);

  // Popped-out Tauri windows send a dock event back to the main window. The
  // sender owns closing itself; the main app only restores the view/context.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
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
  }, [docMode, panelMode, agentMode, researchMode]);

  // Global keyboard shortcuts.
  // Tauri can activate the native window before the renderer becomes the
  // first responder. In that state renderer-owned shortcuts (Shift+Tab and
  // `/`) appear dead until the user clicks inside the webview. Give the main
  // webview focus once after its first paint; Pi's native global shortcut does
  // not need this, which is why Pi can appear to work while these do not.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
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
  }, [docMode, panelMode, agentMode, researchMode]);

  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode) return;
    const onShiftTabKey = (e: KeyboardEvent) => {
      if (!isPlainShiftTab(e)) return;
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
      const mod = e.metaKey || e.ctrlKey;
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
  }, [docMode, panelMode, agentMode, researchMode]);

  if (docMode) return <DocumentView />;
  if (panelMode) return <PanelWindow kind={panelMode} />;
  if (agentMode) return <AgentWindow />;
  if (researchMode) return <ResearchWindow />;

  if (!vaultPath) {
    return (
      <Welcome
        onOpen={() => void openVault()}
        onRetry={() => unavailableVault && void openVault(unavailableVault.root)}
        loading={loading}
        status={status}
        unavailableVault={unavailableVault}
      />
    );
  }

  const rightRegionOpen = rightStack.length > 0 || !!dragView || !!draggingFile;

  // Collapse / expand every folder in one click.
  const collapseAll = () => {
    const map: Record<string, boolean> = {};
    for (const f of files) {
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
        const minRightWidth = rightStack.includes("agent") ? 420 : 260;
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
