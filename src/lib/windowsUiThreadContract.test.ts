import { describe, expect, it } from "vitest";
import terminalSrc from "../../src-tauri/src/terminal.rs?raw";
import tauriConf from "../../src-tauri/tauri.conf.json?raw";
import storeSrc from "../store.ts?raw";
import agentPanelSrc from "../components/AgentPanel.tsx?raw";
import browserHarnessSrc from "../components/BrowserHarness.tsx?raw";
import { MESA_WINDOW_BACKGROUND, MESA_WINDOW_CHROME } from "./windowChrome";

/** Collapse whitespace so rustfmt's line wrapping cannot break an assertion. */
const flat = (source: string): string => source.replace(/\s+/g, " ");
const terminalFlat = flat(terminalSrc);

/**
 * Windows charges for things macOS gives away, and both costs below are paid on
 * the UI thread — the same thread that dispatches `WM_KEYDOWN` and `WM_PAINT`.
 * Neither is visible in a macOS measurement, so they are pinned here rather
 * than left to a profiler nobody runs on the right OS.
 */
describe("Windows UI-thread cost contract", () => {
  describe("PTY output is coalesced before it crosses the IPC bridge", () => {
    it("stages reads instead of emitting one event per read", () => {
      // Every `terminal://output` event is a JS source string eval'd into the
      // webview, marshalled to the UI thread on Windows and followed by a
      // forced `RedrawWindow`. A measured 1.3 MB Pi response was 1,303 reads.
      expect(terminalSrc).toContain("fn stage_output");
      expect(terminalSrc).toContain("fn commit_pending");
      expect(terminalSrc).toContain("fn flush_delay");
      expect(terminalSrc).toContain("OUTPUT_FLUSH_INTERVAL");
      expect(terminalSrc).toContain("OUTPUT_FLUSH_MAX_BYTES");

      // The reader may only stage; emission belongs to the flusher.
      const reader = flat(
        terminalSrc.slice(
          terminalSrc.indexOf("fn spawn_reader"),
          terminalSrc.indexOf("fn next_output_batch")
        )
      );
      expect(reader).toContain("stream.stage(&decoder.push(&buf[..n]))");
      expect(reader).toContain("stream.close(&decoder.flush())");
      expect(reader).not.toContain("app.emit");
    });

    it("emits from exactly one thread so seq reaches the webview in order", () => {
      const flusher = flat(terminalSrc.slice(terminalSrc.indexOf("fn spawn_flusher")));
      expect(flusher).toContain('app.emit( "terminal://output"');
      // A second `app.emit` anywhere in the file would be a second emitter.
      expect(terminalSrc.match(/app\.emit\(/g)?.length).toBe(1);
    });

    it("never blocks the reader on a coalescing window", () => {
      // Backpressure onto the PTY would stall Pi itself, which is worse than
      // the event storm it replaces.
      expect(terminalSrc).toContain("mesa-terminal-reader");
      expect(terminalSrc).toContain("mesa-terminal-flusher");
    });

    it("idles without polling and exits on EOF", () => {
      expect(terminalSrc).toContain("wake: Condvar");
      expect(terminalFlat).toContain(".wake .wait(history)");
      expect(terminalFlat).toContain(".wake .wait_timeout(history, delay)");
      const flusher = flat(terminalSrc.slice(terminalSrc.indexOf("fn next_output_batch")));
      expect(flusher).toContain("if history.closed { return Vec::new();");
    });

    it("keeps staged bytes out of the snapshot and behind any resize marker", () => {
      // A snapshot that included uncommitted bytes would deliver them twice:
      // once in the replay and again as a live event with a higher seq.
      const snapshot = flat(
        terminalSrc.slice(
          terminalSrc.indexOf("pub fn terminal_snapshot"),
          terminalSrc.indexOf("pub fn terminal_resize")
        )
      );
      expect(snapshot).toContain("session.stream.lock()");
      expect(snapshot).toContain("events: history.replay()");

      // Pre-resize bytes must be committed ahead of the marker, or replay
      // re-wraps them at the new width.
      const pushResize = flat(
        terminalSrc.slice(
          terminalSrc.indexOf("fn push_resize"),
          terminalSrc.indexOf("fn snapshot")
        )
      );
      expect(pushResize).toContain("self.commit_pending(Instant::now())");
      expect(terminalSrc).toContain("session.stream.wake.notify_all()");
    });

    it("bounds a single event so one huge eval cannot replace many small ones", () => {
      expect(terminalSrc).toContain("64 * 1024");
      expect(terminalSrc).toContain("self.pending.is_char_boundary(cut)");
    });
  });

  describe("native windows do not flash light before the webview paints", () => {
    const conf = JSON.parse(tauriConf) as {
      app: { windows: { label: string; theme?: string; backgroundColor?: string }[] };
    };
    const main = conf.app.windows.find((w) => w.label === "main");

    it("gives the main window a dark background and a dark preferred theme", () => {
      // Without `backgroundColor`, tao's WM_ERASEBKGND falls through to a NULL
      // class brush and the WebView2 controller keeps its white default.
      expect(main?.theme).toBe("Dark");
      const [r, g, b] = MESA_WINDOW_BACKGROUND;
      const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      expect(main?.backgroundColor?.toLowerCase()).toBe(hex);
    });

    it("applies the same chrome to the doc popout and the detached Pi surface", () => {
      expect(MESA_WINDOW_CHROME.theme).toBe("dark");
      // The decorated Deep Research monitor is a fourth native window and
      // shares the same dark chrome as the document and Pi windows.
      expect(storeSrc.match(/new WebviewWindow\(/g)?.length).toBe(4);
      // The panel uses a conditional spread so Graph can keep its OS chrome.
      expect(storeSrc.match(/\.\.\.MESA_WINDOW_CHROME/g)?.length).toBe(3);
    });

    it("keeps Graph OS-following while darkening other Mesa-owned panels", () => {
      // Graph is deliberately excluded. Preview, Tasks, and Calendar are
      // Mesa-owned surfaces and must not flash white before React paints.
      const panelWindow = storeSrc.slice(
        storeSrc.indexOf("openPanelWindow: async"),
        storeSrc.indexOf("ensureContent: async")
      );
      expect(panelWindow).toContain("new WebviewWindow(");
      expect(panelWindow).toContain('panel === "graph" ? {} : MESA_WINDOW_CHROME');
    });

    it("reuses one native window per detached panel", () => {
      const panelWindow = storeSrc.slice(
        storeSrc.indexOf("openPanelWindow: async"),
        storeSrc.indexOf("ensureContent: async")
      );
      expect(panelWindow).toContain('const label = `panel-${panel}`');
      expect(panelWindow).toContain("WebviewWindow.getByLabel(label)");
      expect(panelWindow).toContain("await existing.setFocus()");
      expect(panelWindow).not.toContain("Date.now().toString(36)");
    });

    it("handles asynchronous native-window creation failures", () => {
      const documentWindow = storeSrc.slice(
        storeSrc.indexOf("openDocWindow: async"),
        storeSrc.indexOf("openAgentWindow: async")
      );
      const researchWindow = storeSrc.slice(
        storeSrc.indexOf("openResearchWindow: async"),
        storeSrc.indexOf("openVault: async")
      );
      const panelWindow = storeSrc.slice(
        storeSrc.indexOf("openPanelWindow: async"),
        storeSrc.indexOf("ensureContent: async")
      );
      for (const source of [documentWindow, researchWindow, panelWindow]) {
        expect(source).toContain('once("tauri://error"');
      }
      expect(documentWindow).toContain("restored inside Mesa");
      expect(researchWindow).toContain("openDeepResearch(true)");
      expect(panelWindow).toContain("dockPanel();");
    });

    it("leaves the Pi browser harness alone", () => {
      // It hosts arbitrary web pages, which are overwhelmingly light; forcing
      // dark chrome there would move the flash, not remove it.
      expect(browserHarnessSrc).toContain("new WebviewWindow(");
      expect(browserHarnessSrc).not.toContain("MESA_WINDOW_CHROME");
      expect(agentPanelSrc).not.toContain("MESA_WINDOW_CHROME");
    });
  });
});
