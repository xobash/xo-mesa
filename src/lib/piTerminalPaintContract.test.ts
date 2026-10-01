import { describe, expect, it } from "vitest";
import terminalSrc from "../../src-tauri/src/terminal.rs?raw";
import agentPanelSrc from "../components/AgentPanel.tsx?raw";

/**
 * The Pi terminal "paints twice": a previous render is stranded above the new
 * one, usually as the first word of the following wrapped line sitting alone on
 * its own row. Pi's TUI repaints streaming blocks with cursor-up + rewrite
 * arithmetic, so it double-paints whenever the emulator lays its bytes out in
 * MORE rows than Pi counted on. Every rule below closes one way that can happen.
 */
describe("Pi terminal paint contract", () => {
  it("decodes the PTY stream across read boundaries instead of per chunk", () => {
    // A multi-byte character split by a 4096-byte read became 2-3 U+FFFD
    // columns where Pi wrote one, widening the line enough to wrap a row early.
    expect(terminalSrc).toContain("struct Utf8Stream");
    expect(terminalSrc).toContain("decoder.push(&buf[..n])");
    expect(terminalSrc).toContain("decoder.flush()");
    expect(terminalSrc).toContain("self.carry.extend_from_slice(&rest[valid..])");

    const reader = terminalSrc.slice(
      terminalSrc.indexOf("fn spawn_reader"),
      terminalSrc.indexOf("pub fn terminal_start")
    );
    expect(reader).toContain("let mut decoder = Utf8Stream::default();");
    // The stateless decode is what produced the bug; it must not come back.
    expect(reader).not.toContain("from_utf8_lossy");
  });

  it("reconciles the grid with the PTY after a snapshot replay", () => {
    // Replay is async and spans many frames, so a real fit()-driven resize can
    // land while onResize is suppressed. fit() no-ops once the grid matches the
    // host, so without an unconditional push the PTY stays a different width.
    expect(agentPanelSrc).toContain("function reconcileSharedPiSizeAfterReplay");
    expect(agentPanelSrc).toContain("queueSharedPiResize(term)");

    const replay = agentPanelSrc.slice(
      agentPanelSrc.indexOf("replayingTerminalSnapshot = true;"),
      agentPanelSrc.indexOf("SHARED_PI_SESSION.lastOutputSeq = snapshot.seq;")
    );
    expect(replay).toContain("} finally {");
    expect(replay).toContain("replayingTerminalSnapshot = false;");
    expect(replay).toContain("reconcileSharedPiSizeAfterReplay(terminal);");
  });

  it("keeps every real grid change flowing to the PTY through one queue", () => {
    // fit() is the only sizer, term.onResize the only publisher, and the
    // latest-wins queue the only IPC path: an older async resize landing last
    // leaves the PTY at a stale width, which strands lines the same way.
    expect(agentPanelSrc).toContain("term.onResize(({ cols, rows })");
    expect(agentPanelSrc).toContain("SHARED_PI_RESIZE_QUEUE.enqueue({ sessionId: id, cols, rows })");
    expect(
      agentPanelSrc.match(/invoke\("terminal_resize"/g)?.length
    ).toBe(1);
  });

  it("replays the historical grid timeline rather than the current width", () => {
    // Re-wrapping raw TUI bytes at only the adopting window's width is itself a
    // double-paint source, so history carries resize markers.
    expect(terminalSrc).toContain("TerminalHistoryEntry::Resize");
    expect(terminalSrc).toContain("history.push_resize(rows, cols)");
    expect(agentPanelSrc).toContain("replayTerminalSnapshot(terminal, snapshot)");
  });
});
