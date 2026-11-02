import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore, type DeepResearchRunState } from "../store";
import type { AgentContext } from "../lib/agent";
import { AGENT_CONTEXT_EVENT, AGENT_WINDOW_READY_EVENT } from "../lib/piSessionBridge";
import { DEEP_RESEARCH_STATE_EVENT, DEEP_RESEARCH_STATE_REQUEST_EVENT } from "../lib/deepResearchWindow";
import { claimKeyboardShortcut, isWindowTransferShortcut } from "../lib/shortcuts";
import { closeCurrentPopoutWindow, dockIntoMainWindow, installNativeDragDock } from "../lib/windowDock";
import { DeepResearchPhaseChipWithRun } from "./DeepResearchPhaseChip";
import { AgentSurface, LazyDeepResearchPanel } from "./LazySurfaces";

/** Pi in its own decorated native window (?agent). */
export function AgentWindow() {
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

export function ResearchWindow() {
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
