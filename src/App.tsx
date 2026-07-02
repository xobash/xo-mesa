import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, getStore } from "./store";
import { IN_TAURI, DEMO_ROOT, fileKind, isEditableTextExt } from "./lib/vault";
import { MediaView } from "./components/MediaView";
import { CodeView } from "./components/CodeView";
import { TopBar } from "./components/TopBar";
import { FileTree } from "./components/FileTree";
import { TagList } from "./components/TagList";
import { BookmarksList } from "./components/BookmarksList";
import { Editor } from "./components/Editor";
import { Preview } from "./components/Preview";
import { GraphView } from "./components/GraphView";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPanel } from "./components/SearchPanel";
import { SettingsModal } from "./components/SettingsModal";
import { SyncModal } from "./components/SyncModal";
import { ConnectVaultModal } from "./components/ConnectVaultModal";
import { AgentPanel, AgentOverlay, AgentSurface } from "./components/AgentPanel";
import { TasksModal, TasksPanel } from "./components/TasksModal";
import { Tour, HelpModal, hasToured } from "./components/Guide";
import { Overlay } from "./components/Overlay";
import { DocumentView, DocPopoutModal } from "./components/DocumentView";
import { DropOverlay } from "./components/DropOverlay";
import { PreviewCard } from "./components/PreviewCard";
import { startViewDrag } from "./components/panelDrag";
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
  normalizeDockWindowPayload,
} from "./lib/windowDock";
import {
  claimKeyboardShortcut,
  isPlainShiftTab,
  isTextEntryTarget,
} from "./lib/shortcuts";
import type { SortMode, RightPanel, WorkspaceView, PaneView } from "./types";

/** The document editor stack (tabs + editor / code / media), usable in either
 *  layout region so the editor can be swapped between center and right. */
function DocPane() {
  const activePath = useAppStore((s) => s.activePath);
  const files = useAppStore((s) => s.files);
  const activeFile = activePath
    ? files.find((f) => f.relPath === activePath)
    : undefined;
  const kind = activeFile ? fileKind(activeFile.ext) : "text";
  const editable = !activeFile || isEditableTextExt(activeFile.ext);
  return (
    <>
      <Tabs />
      {kind === "text" ? (
        editable ? (
          <Editor />
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

function viewContent(kind: WorkspaceView) {
  if (kind === "empty") {
    return (
      <div className="editor-empty">
        Open a file, drag a view here, or use Preview · Graph · Tasks.
      </div>
    );
  }
  if (kind === "doc") return <DocPane />;
  if (kind === "agent") return <AgentSurface embedded />;
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

/** The right region: a vertical stack of panels (any number visible at once),
 *  each with a header (drag to reorder / pop out, × to close) and resizable
 *  dividers. Panels are added/removed from the top bar or by dragging here. */
function RightStack() {
  const stack = useAppStore((s) => s.settings.rightStack);
  const drag = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const keyboardFocus = useAppStore((s) => s.keyboardFocus);
  const removeViewFromWorkspace = useAppStore((s) => s.removeViewFromWorkspace);
  const openPanelWindow = useAppStore((s) => s.openPanelWindow);
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  const openAgentWindow = useAppStore((s) => s.openAgentWindow);
  const activePath = useAppStore((s) => s.activePath);
  const ref = useRef<HTMLElement | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({});

  const popOutView = (view: PaneView) => {
    if (view === "doc") {
      if (!activePath) return;
      void openDocWindow(activePath);
      removeViewFromWorkspace("doc");
      return;
    }
    if (view === "agent") {
      void openAgentWindow();
      removeViewFromWorkspace("agent");
      return;
    }
    void openPanelWindow(view);
    removeViewFromWorkspace(view);
  };

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
              <span className="region-grip" aria-hidden="true">
                ⠿
              </span>
              <span className="stack-title">{VIEW_LABEL[p]}</span>
              {p === "doc" ? (
                <>
                  <button
                    className="stack-btn"
                    disabled={!activePath}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => popOutView("doc")}
                    title="Open the active document in a new window"
                  >
                    ⤢
                  </button>
                  <button
                    className="stack-btn"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeViewFromWorkspace("doc")}
                    title="Close editor"
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="stack-btn"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => popOutView(p)}
                    title="Open in a new window"
                  >
                    ⤢
                  </button>
                  <button
                    className="stack-btn"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeViewFromWorkspace(p)}
                    title="Close"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
            <div className="stack-body">{viewContent(p)}</div>
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
      <div
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
      </div>
      <div className="center-body">{viewContent(centerView)}</div>
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
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const selectFile = useAppStore((s) => s.selectFile);
  // The note this panel should follow (so a popped-out Preview shows the SAME
  // document as the pane it came from), passed as ?sel= in the URL.
  const sel = useMemo(() => new URLSearchParams(location.search).get("sel"), []);
  useEffect(() => {
    if (vaultPath && sel) void selectFile(sel);
  }, [vaultPath, sel, selectFile]);

  // Graph view gets a chromeless window: no header bar, just a floating dock
  // icon button so the graph fills the entire window.
  if (kind === "graph") {
    return (
      <div className="panel-window panel-window-chromeless">
        <button
          className="popout-dock-btn"
          onClick={() =>
            void dockIntoMainWindow({
              kind: "panel",
              view: "graph",
              relPath: activePath ?? sel,
            })
          }
          title="Dock into main workspace"
          aria-label="Dock into main workspace"
        >
          {/* "dock" / "bring back" icon */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.4"/>
            <rect x="1.5" y="11" width="13" height="3.5" rx="1.5" fill="currentColor"/>
            <path d="M8 2.5v6M5.5 6L8 8.5L10.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
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
            aria-label="Close"
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
  const sel = useMemo(() => new URLSearchParams(location.search).get("sel"), []);
  useEffect(() => {
    if (vaultPath && sel) void selectFile(sel);
  }, [vaultPath, sel, selectFile]);

  return (
    <div className="agent-window">
      <header className="doc-window-bar">
        <span>Pi agent</span>
        <div className="dock-actions">
          <button
            className="dock-btn"
            onClick={() => void dockIntoMainWindow({ kind: "agent" })}
          >
            Dock
          </button>
          <button
            className="icon-btn"
            onClick={() => void closeCurrentPopoutWindow()}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </header>
      <AgentSurface embedded />
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

function Welcome({ onOpen, loading }: { onOpen: () => void; loading: boolean }) {
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
        <div className="welcome-actions">
          <button className="btn primary" onClick={onOpen} disabled={loading}>
            {loading ? "Opening…" : "Open vault folder"}
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
        {IN_TAURI && (
          <p className="welcome-hint">
            Pick any folder for a new vault, or pull one from another device
            that's sharing it. Notes are plain <code>.md</code> files.
          </p>
        )}
      </div>
      {connectOpen && <ConnectVaultModal onClose={() => setConnectOpen(false)} />}
    </div>
  );
}

export default function App() {
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
  const requestedVault = useMemo(() => routeParams.get("vault") ?? "", [routeParams]);

  const vaultPath = useAppStore((s) => s.vaultPath);
  const files = useAppStore((s) => s.files);
  const graphFull = useAppStore((s) => s.graphFull);
  const loading = useAppStore((s) => s.loading);
  const openVault = useAppStore((s) => s.openVault);
  const theme = useAppStore((s) => s.theme);
  const animations = useAppStore((s) => s.settings.animations);
  const hardwareAccel = useAppStore((s) => s.settings.hardwareAccel);
  const sidebarOpen = useAppStore((s) => s.settings.sidebarOpen);
  const sidebarWidth = useAppStore((s) => s.settings.sidebarWidth);
  const sidebarAutoHide = useAppStore((s) => s.settings.sidebarAutoHide);
  const rightWidth = useAppStore((s) => s.settings.rightWidth);
  const rightStack = useAppStore((s) => s.settings.rightStack);
  const dockSide = useAppStore((s) => s.settings.dockSide);
  const dragView = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const syncAutoMinutes = useAppStore((s) => s.settings.syncAutoMinutes);
  const syncEnabled = useAppStore((s) => s.settings.syncEnabled);
  const syncPeerCount = useAppStore((s) => s.settings.peers.length);
  const syncToken = useAppStore((s) => s.settings.syncToken);
  const setSetting = useAppStore((s) => s.setSetting);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const vimPrefixRef = useRef<"g" | "window" | null>(null);
  const leftShiftDownRef = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = theme;
      if (theme === "system") {
        // System has its OWN neutral palette that follows the OS via data-mode,
        // rather than aliasing to another theme.
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        root.dataset.mode = dark ? "dark" : "light";
      } else {
        delete root.dataset.mode;
      }
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.anim = animations ? "on" : "off";
  }, [animations]);
  useEffect(() => {
    document.documentElement.dataset.accel = hardwareAccel ? "on" : "off";
  }, [hardwareAccel]);

  // First-run guided tour, once the vault is open.
  useEffect(() => {
    if (docMode || panelMode || agentMode || !vaultPath || hasToured()) return;
    const t = setTimeout(() => getStore().setTourOpen(true), 450);
    return () => clearTimeout(t);
  }, [vaultPath, docMode, panelMode, agentMode]);

  // Crash-safe autosave: flush the active note when the window is hidden,
  // blurred, or closing, so a debounced edit is never lost.
  useEffect(() => {
    if (docMode) return;
    const flush = () => getStore().flushSave();
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

  // Auto-open: demo vault in the browser, last-used vault in the desktop app.
  useEffect(() => {
    if (docMode || useAppStore.getState().vaultPath) return;
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
  }, [openVault, docMode, requestedVault]);

  useEffect(() => {
    if (
      docMode ||
      panelMode ||
      agentMode ||
      !vaultPath ||
      !syncEnabled ||
      !syncToken ||
      syncPeerCount === 0 ||
      syncAutoMinutes <= 0
    )
      return;
    const ms = Math.max(1, syncAutoMinutes) * 60_000;
    const id = window.setInterval(() => {
      const st = getStore();
      if (!st.syncBusy) void st.syncAll();
    }, ms);
    return () => window.clearInterval(id);
  }, [
    docMode,
    panelMode,
    agentMode,
    vaultPath,
    syncEnabled,
    syncToken,
    syncPeerCount,
    syncAutoMinutes,
  ]);

  // Popped-out Tauri windows send a dock event back to the main window. The
  // sender owns closing itself; the main app only restores the view/context.
  useEffect(() => {
    if (docMode || panelMode || agentMode || !IN_TAURI) return;
    let alive = true;
    let unlistenDock: (() => void) | null = null;
    let unlistenAgent: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
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
    });
    return () => {
      alive = false;
      unlistenDock?.();
      unlistenAgent?.();
    };
  }, [docMode, panelMode, agentMode]);

  // Global keyboard shortcuts.
  useEffect(() => {
    if (docMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "ShiftLeft") leftShiftDownRef.current = true;
      const el = document.activeElement as HTMLElement | null;
      const editable = isTextEntryTarget(el);
      // Shift+Tab toggles the Steam-style overlay — unless the user is typing in
      // a field, where Shift+Tab keeps its normal reverse-focus behaviour.
      // Guard against key-repeat (holding Shift+Tab) so the overlay doesn't
      // rapidly toggle open→closed→open on every auto-repeated keydown.
      if (isPlainShiftTab(e)) {
        if (!editable && !e.repeat) {
          claimKeyboardShortcut(e);
          getStore().toggleOverlay();
          return;
        }
        if (!editable) {
          // Still prevent default on repeats so the browser doesn't move focus
          claimKeyboardShortcut(e);
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "p") {
        e.preventDefault();
        getStore().setPalette(true);
        return;
      } else if (mod && e.shiftKey && k === "f") {
        e.preventDefault();
        getStore().setSearchSeed("");
        getStore().setSearch(true);
        return;
      } else if (mod && e.key === ",") {
        e.preventDefault();
        getStore().setSettingsOpen(true);
        return;
      } else if (mod && leftShiftDownRef.current && e.code === "Space") {
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
        st.setSearchSeed("");
        st.setSearch(true);
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
      if (e.code === "ShiftLeft") leftShiftDownRef.current = false;
    };
    const onBlur = () => {
      leftShiftDownRef.current = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [docMode]);

  if (docMode) return <DocumentView />;
  if (panelMode) return <PanelWindow kind={panelMode} />;
  if (agentMode) return <AgentWindow />;

  if (!vaultPath) {
    return <Welcome onOpen={() => void openVault()} loading={loading} />;
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
    const startW = side === "left" ? sidebarWidth : rightWidth;
    const move = (ev: PointerEvent) => {
      if (!el) return;
      const dx = ev.clientX - startX;
      if (side === "left") {
        const w = Math.max(160, Math.min(520, startW + dx));
        el.style.setProperty("--sidebar-w", w + "px");
        el.dataset.dragS = String(w);
      } else {
        // Dock resize: the splitter sits on the dock's outer edge, so the drag
        // sign flips with the dock side (drag toward the dock widens it).
        const sign = dockSide === "left" ? 1 : -1;
        const w = Math.max(260, Math.min(760, startW + sign * dx));
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
    <div className="app">
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
              "--sidebar-w": sidebarOpen ? sidebarWidth + "px" : "0px",
              "--right-w": rightWidth + "px",
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
      <CommandPalette />
      <SearchPanel />
      <SettingsModal />
      <SyncModal />
      <AgentPanel />
      <AgentOverlay />
      <TasksModal />
      <HelpModal />
      <Tour />
      <DocPopoutModal />
      <DropOverlay />
      <PreviewLayer />
      <DragGhostLayer />
      <Overlay />
    </div>
  );
}
