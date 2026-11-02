import { syncSecretsNeededAtStartup } from "./lib/syncSecrets";
import { Modal } from "./components/Modal";
import { confirmAction } from "./lib/confirmAction";
import { loadRecentVaults, resolveRecentVault } from "./lib/persistedUi";
import { flushBeforeClose, installCloseGuard, pendingEditGuard, type BlockedClose } from "./lib/closeGuard";
const QUIT_REQUESTED_EVENT = "mesa://quit-requested";
import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { useAppStore, getStore } from "./store";
import type { AppState } from "./store";
import { IN_TAURI, DEMO_ROOT, fileKind, isEditableTextExt, isTextualVaultFile } from "./lib/vault";
import { MediaView } from "./components/MediaView";
import { CodeView } from "./components/CodeView";
import { docPanePath, isDocPane, type DocPaneId } from "./lib/docSplit";
import { TopBar } from "./components/TopBar";
import { FileTree } from "./components/FileTree";
import { TagList } from "./components/TagList";
import { BookmarksList } from "./components/BookmarksList";
import { Preview } from "./components/Preview";
import { StatusBar } from "./components/StatusBar";
import { TasksModal, TasksPanel } from "./components/TasksModal";
import { Tour, HelpModal, hasToured } from "./components/Guide";
import {
  DocumentView,
  DocPopoutModal,
  DOCUMENT_CATALOG_EVENT,
  DOCUMENT_CATALOG_REQUEST_EVENT,
} from "./components/DocumentView";
import { DropOverlay } from "./components/DropOverlay";
import { startViewDrag } from "./components/panelDrag";
import { useApplyTheme } from "./components/useApplyTheme";
import { useTrayStatus } from "./components/useTrayStatus";
import { useCustomHotkeys } from "./components/useCustomHotkeys";
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
import type { RightPanel, WorkspaceView } from "./types";
import { consumeGraphWindowBootstrap } from "./lib/graphWindowBootstrap";
import { AGENT_CONTEXT_EVENT } from "./lib/piSessionBridge";
import {
  DEEP_RESEARCH_STATE_EVENT,
  DEEP_RESEARCH_STATE_REQUEST_EVENT,
} from "./lib/deepResearchWindow";
import {
  buildAgentContext,
  contextPrompt,
} from "./lib/agent";
import {
  LatestWinsQueue,
  SupersededTaskError,
} from "./lib/latestWinsQueue";
import { backgroundWork } from "./lib/backgroundWorkGovernor";
import { autoSyncBaseDelayMs, nextAutoSyncDelayMs } from "./lib/syncAutoSchedule";
import { AgentSurface, AgentWindows, Editor, EphemeralModals, GraphView, OverlayBoundary } from "./components/LazySurfaces";
import { AgentWindow, ResearchWindow } from "./components/DetachedWindows";
import { DragGhostLayer, PreviewLayer } from "./components/FloatingLayers";
import { Tabs } from "./components/Tabs";
import { SortMenu } from "./components/SortMenu";
import { Welcome } from "./components/Welcome";

// Main-workspace context changes can be faster than Tauri IPC completion
// (e.g. keyboard navigation through notes). Serialize them and skip queued
// stale values so Rust's per-turn context can never settle on an older view.
const PI_CONTEXT_PUBLISH_QUEUE = new LatestWinsQueue<string, void>();

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

/** The document editor stack (tabs + editor / code / media), usable in either
 *  layout region so the editor can be swapped between center and right. */
function DocPane() {
  const activePath = useAppStore((s) => s.activePath);
  const activeContentState = useAppStore((s) => s.activeContentState);
  const loadActiveContent = useAppStore((s) => s.loadActiveContent);
  // Resolve the active file through the store index instead of subscribing to
  // the whole `files` array and scanning it. Only `ext` is read below, so this
  // also stops the editor stack re-rendering for vault-wide array replacements
  // (deferred metadata hydration, watcher batches) that left this file alone.
  const activeFile = useAppStore((s) =>
    s.activePath ? s.fileFor(s.activePath) : undefined
  );
  const kind = activeFile ? fileKind(activeFile.ext) : "text";
  const editable = !activeFile || isEditableTextExt(activeFile.ext);
  const unavailableText = activeFile && isTextualVaultFile(activeFile) && !editable && activeContentState !== "ready";
  return (
    // Pi's mesa_view tool captures the live document from this marked region.
    <div className="doc-live-view" data-mesa-view-root="live-doc">
      <Tabs />
      {unavailableText ? (
        <div className="doc-load-state" role="status">
          <p>{activeContentState === "loading" ? "Loading document…" : activeContentState === "size-limit"
            ? "This file exceeds the 8 MiB automatic text limit." : "This document could not be read."}</p>
          {activeContentState !== "loading" && <button className="btn" onClick={() => void loadActiveContent()}>
            {activeContentState === "size-limit" ? "Load file anyway" : "Retry read"}
          </button>}
        </div>
      ) : kind === "text" ? (
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
    </div>
  );
}

/** One side of a side-by-side document split. The live pane hosts the single
 *  editor; the other pane shows its file read-only until clicked. */
function DocSlot({ pane }: { pane: DocPaneId }) {
  const live = useAppStore((s) => s.docSplit.active === pane);
  const other = useAppStore((s) => s.docSplit.other);
  const file = useAppStore((s) => (other ? s.fileFor(other) : undefined));
  if (live) return <DocPane />;
  if (!other || !file) {
    return <div className="editor-empty">Drag a file here, or use “Open to the side” on a file.</div>;
  }
  const activate = () => void getStore().focusDocPane(pane);
  const kind = fileKind(file.ext);
  return (
    <div
      className="doc-slot-idle"
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      title="Click to edit this document"
    >
      {kind === "text" ? <CodeView rel={other} /> : <MediaView rel={other} />}
    </div>
  );
}

/** Pane header text: document panes name their file, other views their kind. */
function ViewTitle({ view }: { view: WorkspaceView }) {
  const docTitle = useAppStore((s) => {
    if (!isDocPane(view)) return null;
    const rel = docPanePath(view, s.docSplit, s.activePath);
    if (!rel) return null;
    return s.notes[rel]?.title ?? rel.split("/").pop() ?? rel;
  });
  // In a two-document split, mark which pane is the live editor.
  const live = useAppStore((s) => isDocPane(view) && s.docSplit.other !== null && s.docSplit.active === view);
  return <span className={"stack-title" + (live ? " doc-live" : "")}>{docTitle ?? VIEW_LABEL[view]}</span>;
}

function panelContent(kind: RightPanel) {
  if (kind === "preview") return <Preview />;
  if (kind === "graph") return <GraphView />;
  return <TasksPanel />;
}

function viewContent(
  kind: WorkspaceView,
  agentProps: Partial<React.ComponentProps<typeof AgentSurface>> = {}
) {
  if (kind === "empty") {
    return (
      <div className="editor-empty">
        Open a file, drag a view here, or use Preview · Graph · Tasks.
      </div>
    );
  }
  if (isDocPane(kind)) return <DocSlot pane={kind} />;
  if (kind === "agent") return <AgentSurface embedded {...agentProps} />;
  return panelContent(kind);
}

const VIEW_LABEL: Record<WorkspaceView, string> = {
  empty: "Workspace",
  doc: "Editor",
  doc2: "Editor",
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
      {stack.length === 0 && !drag && !draggingFile && (
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
                <ViewTitle view={p} />
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
        <ViewTitle view={centerView} />
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

const { flush: flushAllEdits, pending: hasPendingEdits } = pendingEditGuard(getStore);

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
  const usableRightWidth = rightStack.includes("agent") ? Math.max(420, rightWidth) : rightWidth;
  const dockSide = useAppStore((s) => s.settings.dockSide);
  const dragView = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const syncAutoMinutes = useAppStore((s) => s.settings.syncAutoMinutes);
  const syncEnabled = useAppStore((s) => s.settings.syncEnabled);
  const syncPeerCount = useAppStore((s) => s.settings.peers.length);
  const syncToken = useAppStore((s) => s.settings.syncToken);
  const setSetting = useAppStore((s) => s.setSetting);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const vimPrefixRef = useRef<"g" | "window" | null>(null);
  const leftShiftDownRef = useRef(false);

  useApplyTheme(theme, uiStyle);
  useTrayStatus(IN_TAURI && !docMode && !panelMode && !agentMode && !researchMode);
  useCustomHotkeys(!docMode && !panelMode && !agentMode && !researchMode);

  // Detached documents reuse the main renderer's live file catalog. They
  // read only their selected document and never start another vault walk.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
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
  }, [docMode, panelMode, agentMode, researchMode]);

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

  // Main owns live workspace context. Detached Pi surfaces receive it but never publish it back.
  // Publish from a store subscription: navigation and settings changes must
  // not re-render the whole shell just to rebuild this context.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
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
  }, [docMode, panelMode, agentMode, researchMode]);

  // Pi's mesa_view tool asks main for the rendered pixels of the current view.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<string>("mesa://view-request", (event) => {
      const state = getStore();
      void import("./lib/viewCapture").then(({ answerViewRequest }) =>
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
  }, [docMode, panelMode, agentMode, researchMode]);

  // First-run guided tour, once the vault is open.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !vaultPath || hasToured()) return;
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
        flushAllEdits,
        hasPendingEdits,
        (status) => useAppStore.setState({ status }),
        onBlocked
      );
    }).catch((error) => {
      if (!disposed) useAppStore.setState({ status: `Close safety failed to start: ${String(error)}` });
    });
    return () => { disposed = true; stop?.(); };
  }, [docMode, panelMode, agentMode, researchMode, onBlocked]);

  // macOS Quit requests bypass a window's close handler. Hold the app alive
  // until the same verified text flush succeeds, including failed-save cases.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || !IN_TAURI) return;
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
  }, [docMode, panelMode, agentMode, researchMode, onBlocked]);

  // Auto-open: demo vault in the browser, last-used vault in the desktop app.
  useEffect(() => {
    if (!IN_TAURI || docMode || panelMode || agentMode || researchMode) return;
    if (!syncSecretsNeededAtStartup(getStore().settings)) return;
    void getStore().loadSyncSecrets().catch(() => undefined);
  }, [docMode, panelMode, agentMode, researchMode]);

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
  }, [openVault, docMode, panelMode, agentMode, researchMode, requestedVault]);

  // Network/removable volumes do not reliably emit a browser-visible mount
  // event. Retry at a modest cadence while the unavailable screen is visible,
  // and immediately when the user returns to Mesa. The store's loading guard
  // prevents overlapping scans; a successful open clears unavailableVault and
  // tears this effect down.
  useEffect(() => {
    if (docMode || panelMode || agentMode || researchMode || vaultPath || !unavailableVault) return;
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

  // Focus the main webview after its first paint so renderer shortcuts receive input.
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
