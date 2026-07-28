import { describe, expect, it } from "vitest";
import terminalSrc from "../../src-tauri/src/terminal.rs?raw";
import appSrc from "../App.tsx?raw";
import agentPanelSrc from "../components/AgentPanel.tsx?raw";
import overlaySrc from "../components/Overlay.tsx?raw";
import storeSrc from "../store.ts?raw";
import windowDockSrc from "./windowDock.ts?raw";
import capabilitiesSrc from "../../src-tauri/capabilities/default.json?raw";

describe("Windows Pi launcher contract", () => {
  it("prefers PATHEXT launcher candidates before a bare pi script", () => {
    const extLoop = terminalSrc.indexOf('for ext in pathext.split');
    const rawName = terminalSrc.indexOf('names.push(OsString::from(name));');
    expect(extLoop).toBeGreaterThan(-1);
    expect(rawName).toBeGreaterThan(extLoop);
  });

  it("supports Node-backed Pi scripts on Windows", () => {
    expect(terminalSrc).toContain("script_uses_node(pi)");
    expect(terminalSrc).toContain("resolve_node_binary_for_script(script)");
    expect(terminalSrc).toContain('cmd.arg(script.to_string_lossy().to_string())');
  });

  it("falls back to cmd.exe for cmd and bat wrappers", () => {
    expect(terminalSrc).toContain('matches!(ext.as_str(), "cmd" | "bat")');
    expect(terminalSrc).toContain('cmd.arg("/d")');
    expect(terminalSrc).toContain('cmd.arg("/s")');
    expect(terminalSrc).toContain('cmd.arg("/c")');
  });

  it("keeps replayable sequenced output for cross-window Pi handoff", () => {
    expect(terminalSrc).toContain("TerminalHistory");
    expect(terminalSrc).toContain("pub fn terminal_snapshot");
    expect(terminalSrc).toContain("TerminalHistoryEntry::Resize");
    expect(terminalSrc).toContain("events: history.replay()");
    expect(terminalSrc).toContain("seq: u64");
  });

  it("opens the complete Pi surface in a decorated, movable native window", () => {
    const opener = storeSrc.slice(
      storeSrc.indexOf("openAgentWindow: async"),
      storeSrc.indexOf("openVault: async")
    );
    expect(opener).toContain("new WebviewWindow");
    expect(opener).toContain("decorations: true");
    expect(opener).toContain('titleBarStyle: "overlay"');
    expect(opener).toContain("hiddenTitle: true");
    expect(opener).toContain("visible: true");
    expect(opener).not.toContain("await win.show()");
    expect(opener).toContain("AGENT_WINDOW_READY_EVENT");
    expect(opener).toContain("getPiSessionSnapshot()");
    expect(opener).toContain("Pi is still starting.");
    expect(opener).toContain("await ready");
    expect(opener).toContain("Pi tear-out failed:");
    expect(opener).toContain("reclaimMainPiResizeOwnership()");
    expect(opener).toContain("if (creationFailed)");
    expect(opener).toContain("both Pi surfaces were kept open");
    expect(opener).not.toContain("terminal_open_native");

    const agentWindow = appSrc.slice(
      appSrc.indexOf("function AgentWindow"),
      appSrc.indexOf("/** Single floating preview")
    );
    expect(agentWindow).toContain("<AgentSurface");
    expect(agentWindow).toContain("attachSessionId={attachSessionId}");
    expect(agentWindow).toContain("vaultPathOverride={agentVaultPath}");
    expect(agentWindow).toContain("{agentVaultPath ? (");
    expect(agentWindow).toContain("nativeDragRegion");
    expect(agentWindow).toContain("onSessionReady={announceReady}");
    expect(agentWindow).toContain("await emit(AGENT_WINDOW_READY_EVENT");
    expect(agentWindow).toContain("installNativeDragDock");
    expect(agentWindow).toContain("requireUserDragArm: true");
    expect(windowDockSrc).toContain("pointerWasOutsideMain = false;");
    expect(windowDockSrc).toContain("gestureReleased = true;");
    expect(windowDockSrc).toContain("if (cursorInsideMain || gestureReleased)");
    expect(storeSrc).toContain("detached Pi focus request failed:");
    expect(agentPanelSrc).toContain("data-tauri-drag-region");
    for (const permission of [
      "core:window:allow-close",
      "core:window:allow-set-focus",
      "core:window:allow-start-dragging",
    ]) {
      expect(capabilitiesSrc).toContain(`"${permission}"`);
    }
    expect(
      agentPanelSrc.match(/data-tauri-drag-region=\{nativeDragRegion/g)?.length
    ).toBeGreaterThanOrEqual(4);
    const postAdoption = opener.slice(
      opener.indexOf("await win.setFocus()"),
      opener.indexOf("return true", opener.indexOf("await win.setFocus()"))
    );
    expect(postAdoption).toContain("detached Pi focus request failed:");
    expect(postAdoption).not.toContain("win.close()");
  });

  it("keeps the source Pi mounted until the detached window adopts the PTY", () => {
    const floating = agentPanelSrc.slice(agentPanelSrc.indexOf("function PiFloatingWindow"));
    const steam = overlaySrc.slice(overlaySrc.indexOf("function PiOverlayWindow"));
    for (const source of [floating, steam]) {
      const openCall = source.indexOf("openAgentWindow(");
      const closeAfterReady = source.indexOf("if (opened) onClose()", openCall);
      expect(openCall).toBeGreaterThan(-1);
      expect(closeAfterReady).toBeGreaterThan(openCall);
    }
    expect(agentPanelSrc).toContain("onSessionReady?.(id)");
    const adoption = agentPanelSrc.slice(
      agentPanelSrc.indexOf("const toAttach = pendingAttachRef.current"),
      agentPanelSrc.indexOf("if (!alive) return", agentPanelSrc.indexOf("const toAttach"))
    );
    expect(adoption).toContain("await adoptSharedPiSession");
    expect(adoption).not.toContain("starting a new one");
    expect(adoption.match(/ensureSharedPiSession/g)?.length).toBe(1);
  });

  it("forwards detached-window typing to the existing backend session", () => {
    expect(agentPanelSrc).toContain("async function adoptSharedPiSession");
    expect(agentPanelSrc).toContain('invoke("terminal_attach"');
    expect(agentPanelSrc).toContain("term.onData((input)");
    expect(agentPanelSrc).toContain('invoke("terminal_write", { sessionId: id, input })');
    expect(agentPanelSrc).toContain("attachSharedPiOutputListener()");
  });

  it("keeps detached context live and gives only one renderer resize ownership", () => {
    expect(appSrc).toContain("AGENT_CONTEXT_EVENT");
    expect(appSrc).toContain('invoke("activity_set_context"');
    expect(appSrc).toContain("contextOverride={contextOverride}");
    expect(storeSrc).toContain("AGENT_CONTEXT_EVENT");
    expect(storeSrc).toContain("emitTo(");
    expect(agentPanelSrc).toContain("claimSharedPiResizeOwnership");
    expect(agentPanelSrc).toContain("createLatestTerminalResizeQueue");
    expect(terminalSrc).toContain("resize_owner");
    expect(terminalSrc).toContain("session.resize_owner != window.label()");
  });
});
