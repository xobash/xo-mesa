import { Suspense, lazy, useEffect, useState } from "react";
import { useAppStore } from "../store";

// The CodeMirror editor stack (~590 kB min across codemirror + @lezer) is the
// entry chunk's largest resident, and only the main window's DocPane ever
// renders it — popout windows (?doc / ?panel / ?agent) boot the same entry
// chunk and never mount the editor. Load it lazily so the shell (and every
// popout) parses half as much JS; same stance as the pdf-lib and xterm splits.
export const Editor = lazy(() =>
  import("./Editor").then((m) => ({ default: m.Editor }))
);

// Graph is not part of the default Editor + Preview workspace, but its canvas
// renderer and d3-force stack were paid by every main/popout startup. Keep the
// same component boundary while loading it only when a graph surface mounts.
const LazyGraphView = lazy(() =>
  import("./GraphView").then((m) => ({ default: m.GraphView }))
);

const LazyAgentSurface = lazy(() =>
  import("./AgentPanel").then((m) => ({ default: m.AgentSurface }))
);
const LazyAgentPanel = lazy(() =>
  import("./AgentPanel").then((m) => ({ default: m.AgentPanel }))
);
const LazyAgentOverlay = lazy(() =>
  import("./AgentPanel").then((m) => ({ default: m.AgentOverlay }))
);
export const LazyDeepResearchPanel = lazy(() =>
  import("./DeepResearchPanel").then((m) => ({ default: m.DeepResearchPanel }))
);
const LazyOverlay = lazy(() =>
  import("./Overlay").then((m) => ({ default: m.Overlay }))
);
const LazyCommandPalette = lazy(() =>
  import("./CommandPalette").then((m) => ({ default: m.CommandPalette }))
);
const LazySearchPanel = lazy(() =>
  import("./SearchPanel").then((m) => ({ default: m.SearchPanel }))
);
const LazySettingsModal = lazy(() =>
  import("./SettingsModal").then((m) => ({ default: m.SettingsModal }))
);
const LazyDiagnosticsModal = lazy(() =>
  import("./DiagnosticsModal").then((m) => ({ default: m.DiagnosticsModal }))
);
const LazySyncModal = lazy(() =>
  import("./SyncModal").then((m) => ({ default: m.SyncModal }))
);

export function GraphView() {
  return (
    <Suspense fallback={<div className="graph-wrap" aria-busy="true" />}>
      <LazyGraphView />
    </Suspense>
  );
}

export function AgentSurface(props: React.ComponentProps<typeof LazyAgentSurface>) {
  return (
    <Suspense fallback={<div className="agent-surface" aria-busy="true" />}>
      <LazyAgentSurface {...props} />
    </Suspense>
  );
}

/** Closed Pi windows should not pull the terminal/harness surface tree into
 * startup. Their store flags already own visibility, so gate the lazy module
 * at the same boundary. */
export function AgentWindows() {
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

/** Load the Mesa overlay only on first use, then keep it mounted forever so
 * Overlay's existing 240 ms close animation can finish after `open` flips. */
export function OverlayBoundary() {
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

export function EphemeralModals() {
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
