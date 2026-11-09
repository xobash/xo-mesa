import { Suspense } from "react";
import { useAppStore, getStore } from "../store";
import { fileKind, isEditableTextExt, isTextualVaultFile } from "../lib/vault";
import { docPanePath, isDocPane, type DocPaneId } from "../lib/docSplit";
import { claimKeyboardShortcut, isWindowTransferShortcut } from "../lib/shortcuts";
import type { RightPanel, WorkspaceView } from "../types";
import { MediaView } from "./MediaView";
import { CodeView } from "./CodeView";
import { Preview } from "./Preview";
import { TasksPanel } from "./TasksModal";
import { Tabs } from "./Tabs";
import { AgentSurface, Editor, GraphView } from "./LazySurfaces";

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
export function ViewTitle({ view }: { view: WorkspaceView }) {
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

export function panelContent(kind: RightPanel) {
  if (kind === "preview") return <Preview />;
  if (kind === "graph") return <GraphView />;
  return <TasksPanel />;
}

export function viewContent(
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

export const VIEW_LABEL: Record<WorkspaceView, string> = {
  empty: "Workspace",
  doc: "Editor",
  doc2: "Editor",
  agent: "Pi",
  preview: "Preview",
  graph: "Graph",
  tasks: "Tasks",
};

export function handleWorkspacePiTearOff(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return;
  if (!isWindowTransferShortcut(event)) return;
  claimKeyboardShortcut(event.nativeEvent);
  void getStore().openAgentWindow().then((opened) => {
    if (opened) getStore().removeViewFromWorkspace("agent");
  });
}
