import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const agentPanel = readFileSync(new URL("../components/AgentPanel.tsx", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../components/Overlay.tsx", import.meta.url), "utf8");
const graphView = readFileSync(new URL("../components/GraphView.tsx", import.meta.url), "utf8");
const drPanel = readFileSync(new URL("../components/DeepResearchPanel.tsx", import.meta.url), "utf8");
const drPhaseChip = readFileSync(new URL("../components/DeepResearchPhaseChip.tsx", import.meta.url), "utf8");
const topBar = readFileSync(new URL("../components/TopBar.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

/** Body of the first rule whose selector matches `re` (text between its
 *  opening `{` and matching closing `}`). */
function ruleBody(re) {
  const m = re.exec(css);
  if (!m) return "";
  const start = m.index + m[0].length; // just after the matched `{`
  let depth = 1;
  let i = start;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(start, i);
}

function hexLuminance(hex) {
  const raw = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(raw.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function tokenHex(block, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  return match?.[1] ?? "";
}

function tokenNumber(block, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*([0-9.]+)`).exec(block);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

function tokenRgbaAlpha(block, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*rgba\\([^,]+,[^,]+,[^,]+,\\s*([0-9.]+)\\)`).exec(block);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

describe("layout css", () => {
  describe("graph color tokens", () => {
    it("keeps isolated notes dimmer than linked notes without making them unreadable", () => {
      const themes = [
        ruleBody(/:root,\s*:root\[data-theme="void"\]\s*\{/),
        ruleBody(/:root\[data-theme="darkroom"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\[data-mode="dark"\]\s*\{/),
      ];

      for (const block of themes) {
        const node = hexLuminance(tokenHex(block, "--graph-node"));
        const isolated = hexLuminance(tokenHex(block, "--graph-node-isolated"));
        expect(isolated).toBeLessThan(node);
        expect(isolated / node).toBeGreaterThanOrEqual(0.42);
      }
    });

    it("keeps fitted graph links visible enough to inspect at Obsidian-like scale", () => {
      const themes = [
        ruleBody(/:root,\s*:root\[data-theme="void"\]\s*\{/),
        ruleBody(/:root\[data-theme="darkroom"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\[data-mode="dark"\]\s*\{/),
      ];

      for (const block of themes) {
        expect(tokenRgbaAlpha(block, "--graph-link")).toBeGreaterThanOrEqual(0.1);
      }
    });

    it("keeps the full graph bloom only on the void theme", () => {
      const voidBlock = ruleBody(/:root,\s*:root\[data-theme="void"\]\s*\{/);
      const nonVoidBlocks = [
        ruleBody(/:root\[data-theme="darkroom"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\[data-mode="dark"\]\s*\{/),
      ];

      expect(tokenNumber(voidBlock, "--graph-bloom-alpha")).toBe(1);
      for (const block of nonVoidBlocks) {
        const alpha = tokenNumber(block, "--graph-bloom-alpha");
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThan(1);
      }
    });
  });

  it("lets auto-hide fill the workspace when the right stack is closed", () => {
    const autoHideRule = css.search(/\.layout\.auto-hide\s*\{/);
    const autoHideNoRightRule = css.search(/\.layout\.auto-hide\.no-right\s*\{/);
    expect(autoHideRule).toBeGreaterThanOrEqual(0);
    expect(autoHideNoRightRule).toBeGreaterThan(autoHideRule);

    const block = ruleBody(/\.layout\.auto-hide\.no-right\s*\{/);
    expect(block).toContain("grid-template-columns: 0 minmax(0, 1fr) 0");
  });

  it("keeps the closed sidebar mounted but non-interactive", () => {
    const block = ruleBody(/\.layout\.no-sidebar\s*>\s*\.sidebar\s*\{/);
    expect(block).toContain("transform: translateX(-100%)");
    expect(block).toContain("opacity: 0");
    expect(block).toContain("visibility: hidden");
    expect(block).toContain("pointer-events: none");
  });

  it("reserves sidebar push space separately from the fixed-width sidebar panel", () => {
    expect(ruleBody(/\.layout\s*\{/)).toContain(
      "grid-template-columns: var(--sidebar-slot-w, 240px) minmax(0, 1fr) var(--right-w, 380px)"
    );
    expect(ruleBody(/^\.sidebar\s*\{/m)).toContain("position: absolute");
    expect(ruleBody(/^\.sidebar\s*\{/m)).toContain("width: var(--sidebar-w, 240px)");
    expect(ruleBody(/\.splitter-left\s*\{/)).toContain("var(--sidebar-slot-w, 240px)");
  });

  it("keeps the Notes header pinned while the sidebar contents scroll", () => {
    const block = ruleBody(/\.sidebar\s*>\s*\.sidebar-header\s*\{/);
    expect(block).toContain("position: sticky");
    expect(block).toContain("top: 0");
    expect(block).toContain("z-index: 2");
    expect(block).toContain("background: var(--bg-1)");
  });

  it("keeps auto-hide sidebar open briefly after hover leaves", () => {
    expect(ruleBody(/\.layout\.auto-hide\s+\.sidebar\s*\{/)).toContain(
      "transition-delay: 0.75s"
    );
    expect(
      ruleBody(/\.layout\.auto-hide\s+\.sidebar-edge:hover\s*\+\s*\.sidebar,\s*\.layout\.auto-hide\s+\.sidebar:hover\s*\{/)
    ).toContain("transition-delay: 0s");
  });

  it("slides the Deep Research wing from behind Pi with token-driven styling", () => {
    const block = ruleBody(/\.dr-wing\.slide\s*\{/);
    expect(block).toContain("position: absolute");
    expect(block).toContain("z-index: 0");
    expect(block).toContain("animation: wing-out");
    expect(block).toContain("box-shadow: var(--pop-shadow)");
    expect(block).not.toContain("rgba(");
    expect(ruleBody(/\.dr-wing\.tear-off-armed::after\s*\{/)).toContain(
      'content: "Release to separate from Pi"'
    );
  });

  it("keeps bounded Pi browsing inside Deep Research instead of replacing it", () => {
    const browserInline = ruleBody(/\.agent-browser-wing\.inline\s*\{/);
    const researchInline = ruleBody(/\.dr-wing\.inline\s*\{/);
    expect(browserInline).toContain("max-width: 50%");
    expect(researchInline).toContain("max-width: 50%");
    expect(agentPanel).toContain("const browserNestedInResearch = browserOpen && researchOpen && !browserSlideOut");
    expect(agentPanel).toContain("browserOpen && !browserNestedInResearch");
    expect(agentPanel).toContain('className="dr-browser-nested"');
    expect(agentPanel).not.toContain("if (!browserSlideOut) setResearchOpen(false)");
    expect(ruleBody(/\.dr-browser-nested\s*\{/)).toContain("border-top: 1px solid var(--border)");
  });

  it("uses one title bar and drag-to-tear-off for every floating Pi window", () => {
    // The one shared floating-window implementation: combined title bar,
    // drag-to-move, drag-to-edge tear-off into a native OS window.
    const floating = agentPanel.slice(agentPanel.indexOf("function PiFloatingWindow"));
    expect(floating).toContain('windowTitle="Pi agent"');
    expect(floating).toContain("onTitleBarPointerDown={startMove}");
    expect(floating).toContain("isWindowTearOffPoint");
    expect(floating).toContain("openAgentWindow(");
    expect(floating).not.toContain('className="pi-overlay-drag"');
    expect(floating).not.toContain("onPopOut");

    // Both in-window floating Pi entry points render THAT implementation —
    // no divergent chrome, and no redundant Pop out button (tear-off owns it).
    const panel = agentPanel.slice(
      agentPanel.indexOf("export function AgentPanel"),
      agentPanel.indexOf("export function AgentOverlay")
    );
    const overlay = agentPanel.slice(agentPanel.indexOf("export function AgentOverlay"));
    expect(panel).toContain("<PiFloatingWindow");
    expect(panel).not.toContain("Pop out");
    expect(overlay).toContain("<PiFloatingWindow");

    // The Steam-overlay Pi window shares the same combined bar + tear-off
    // gesture instead of the generic FloatingWindow chrome (which would stack
    // a second title bar over the Pi toolbar).
    const steam = overlaySource.slice(overlaySource.indexOf("function PiOverlayWindow"));
    expect(steam).toContain('windowTitle="Pi agent"');
    expect(steam).toContain("onTitleBarPointerDown={startDrag}");
    expect(steam).toContain("isWindowTearOffPoint");
    expect(steam).toContain("openAgentWindow(");
    expect(overlaySource).toContain('id === "agent" ? (');

    // Workspace Pi also delegates its header to the same AgentSurface chrome
    // instead of stacking the generic pane header above a reduced toolbar.
    expect(appSource).toContain('p !== "agent" && (');
    expect(appSource).toContain('windowTitle: "Pi agent"');
    expect(appSource).toContain('onTitleBarKeyDown: handleWorkspacePiTearOff');

    expect(ruleBody(/\.pi-terminal-chrome\.window-titlebar\s*\{/)).toContain("cursor: grab");
    expect(
      ruleBody(
        /\.pi-overlay-window\.tear-off-armed::after,\s*\.ov-win\.pi-ov-win\.tear-off-armed::after\s*\{/
      )
    ).toContain('content: "Release to move outside Mesa"');
  });

  it("keeps a workspace Pi pane above a usable terminal floor", () => {
    expect(appSource).toContain('rightStack.includes("agent") ? Math.max(420, rightWidth)');
    const piPane = ruleBody(/\.stack-pane:has\(\.agent-surface\)\s*\{/);
    expect(piPane).toContain("min-height: 300px");
    expect(piPane).toContain("flex-shrink: 0");
    const piStack = ruleBody(/\.right-stack:has\(\.stack-pane \.agent-surface\)\s*\{/);
    expect(piStack).toContain("overflow-y: auto");
  });

  it("projects floating surfaces above the measured wrapping overlay dock", () => {
    expect(overlaySource).toContain("dock.getBoundingClientRect().top");
    expect(overlaySource).toContain("dockTop - 8 + OVERLAY_BOTTOM");
    expect(overlaySource).toContain("fitToViewport(wins[id], safeViewportHeight)");
    expect(overlaySource).toContain('className="ov-dock" ref={dockRef}');
  });

  it("integrates macOS native traffic lights without covering Pi controls", () => {
    expect(css).toMatch(
      /\.agent-window\.titlebar-overlay\s+\.pi-terminal-chrome\.window-titlebar\s*\{[^}]*padding-left:\s*82px/s
    );
    expect(appSource).toContain('titleOverlay ? " titlebar-overlay" : ""');
    expect(agentPanel).toContain("data-tauri-drag-region={nativeDragRegion");
  });

  it("keeps Deep Research to one title bar per mount", () => {
    // The panel renders NO in-body header: its phase chip lives in the host's
    // single title bar (overlay window bar / Pi research wing bar), matching
    // the Pi combined-bar contract. A second in-panel title stacks two bars —
    // the exact chrome divergence the Pi windows were unified away from.
    expect(drPanel).not.toContain("dr-head");
    expect(drPanel).not.toContain("dr-title");
    expect(drPhaseChip).toContain("export function DeepResearchPhaseChip");

    // Overlay mount: the research FloatingWindow carries the chip as its bar
    // accessory. Pi wing mount: the wing bar renders the chip beside its title.
    expect(overlaySource).toContain(
      'accessory={id === "research" ? <DeepResearchPhaseChip /> : undefined}'
    );
    const wingBar = agentPanel.slice(
      agentPanel.indexOf('className="dr-wing-bar"'),
      agentPanel.indexOf("<DeepResearchPanel")
    );
    expect(wingBar).toContain("<DeepResearchPhaseChip />");
    expect(wingBar).toContain("onPointerDown={startResearchDetach}");

    // The bars pin their close control right so the chip joins the left
    // cluster without re-centering; no dead dr-head styling remains.
    expect(ruleBody(/^\.ov-win-close\s*\{/m)).toContain("margin-left: auto");
    expect(ruleBody(/\.dr-wing-bar\s*>\s*\.pi-tool\s*\{/)).toContain("margin-left: auto");
    expect(ruleBody(/\.dr-wing-bar\s*\{/)).toContain("cursor: grab");
    expect(css).not.toContain(".dr-head");
    expect(css).not.toContain(".dr-title");
  });

  it("keeps Deep Research graph nodes circular, bounded, and hover-inspectable", () => {
    expect(ruleBody(/\.dr-root\s*>\s*\*\s*\{/)).toContain("flex: 0 0 auto");
    const graphCanvas = ruleBody(/\.dr-research-graph-canvas\s*\{/);
    expect(graphCanvas).toContain("height: clamp(280px, 52cqw, 520px)");
    expect(graphCanvas).toContain("overflow: hidden");
    expect(graphCanvas).toContain("position: relative");
    expect(graphCanvas).toContain("isolation: isolate");
    expect(ruleBody(/\.dr-research-graph\s*\{/)).toContain("container-type: inline-size");
    const graphSvg = ruleBody(/\.dr-research-graph-svg\s*\{/);
    expect(graphSvg).toContain("width: 100%");
    expect(graphSvg).toContain("height: 100%");
    expect(graphSvg).toContain("max-width: 100%");
    expect(graphSvg).toContain("overflow: hidden");
    expect(drPanel).toContain("width={graph.width}");
    expect(drPanel).toContain("node.hoverRadius");
    expect(drPanel).toContain("follow the arrows");
    expect(drPanel).toContain("markerEnd");
    expect(drPanel).toContain("sourcePresentations");
    expect(drPanel).toContain("run.sources");
    expect(drPanel).toContain("graphCanvasRef");
    expect(drPanel).toContain("preserveAspectRatio=\"none\"");
    expect(drPhaseChip).toContain('className="dr-context-popover"');
    expect(drPhaseChip).toContain("aria-expanded={contextOpen}");
    expect(drPanel).toContain('className="dr-graph-node-label"');
    expect(drPanel).toContain('className="dr-graph-hover-card"');
    expect(drPanel).toContain('className="dr-graph-hitbox"');
    expect(drPanel).toContain("const orderedNodes = hovered");
    expect(drPanel).toContain("graph.nodes.filter((node) => node.id !== hovered.id)");
    expect(drPanel).toContain("[...graph.nodes.filter((node) => node.id !== hovered.id), hovered]");
    expect(drPanel).not.toContain('className="dr-graph-label-layer"');
    expect(drPanel).not.toContain('className="dr-graph-node-text"');
    expect(drPanel).toContain("onMouseEnter");
    expect(drPanel).toContain("graphLayout");
    expect(drPanel).toContain("hideHover");
    expect(drPanel).toContain("copySourceLinkFromGraph");
    expect(ruleBody(/\.dr-graph-node-circle\s*\{/)).toContain("transition: r");
    expect(ruleBody(/\.dr-graph-hover-card\s*\{/)).toContain("pointer-events: auto");
    expect(ruleBody(/\.dr-graph-hover-card\s*\{/)).toContain("z-index: 10");
    expect(ruleBody(/\.dr-active-controls\s*\{/)).toContain("justify-content: flex-start");
    expect(drPanel).toContain("activeRunStarted(run)");
    expect(drPanel).toContain("showActiveRunControls");

    const hoverText = ruleBody(/\.dr-graph-hover-text\s*\{/);
    expect(hoverText).toContain("overflow-wrap: anywhere");
    expect(hoverText).toContain("white-space: pre-wrap");
    expect(drPanel).toContain('className="dr-source-link"');
    expect(drPanel).toContain("<ResearchSourceIcon");
    expect(drPanel).toContain("Open saved page");
    expect(drPanel).toContain('className="dr-graph-hover-actions"');
    expect(ruleBody(/\.dr-graph-hover-actions\s*\{/)).toContain("flex-wrap: wrap");
    expect(ruleBody(/\.dr-query-row\s*\{/)).toContain("margin-top: auto");
  });

  it("keeps Deep Research context previews above surfaces and short flyouts contained", () => {
    expect(drPhaseChip).toContain('import { createPortal } from "react-dom"');
    expect(drPhaseChip).toContain("contextAnchorRef");
    expect(drPhaseChip).toContain("contextPopoverRef");
    expect(drPhaseChip).toContain("getBoundingClientRect");
    expect(drPhaseChip).toContain("document.body");
    expect(drPanel).toContain('className="dr-scroll"');
    expect(drPhaseChip).toContain("onMouseEnter={openContext}");
    expect(drPhaseChip).toContain("onMouseLeave={closeContext}");

    const contextPopover = ruleBody(/\.dr-context-popover\s*\{/);
    expect(contextPopover).toContain("position: fixed");
    expect(contextPopover).toContain("z-index: 1000");
    expect(contextPopover).toContain("max-height");
    expect(contextPopover).toContain("overflow: auto");

    const scrollBody = ruleBody(/\.dr-root > \.dr-scroll\s*\{/);
    expect(scrollBody).toContain("flex: 1 1 auto");
    expect(scrollBody).toContain("min-height: 0");
    expect(scrollBody).toContain("overflow-y: auto");
    expect(ruleBody(/\.dr-scroll\s*>\s*\*\s*\{/)).toContain("flex: 0 0 auto");
    const initialWing = ruleBody(/\.dr-wing\.initial\s*\{/);
    expect(initialWing).toContain("top: 44px");
    expect(initialWing).toContain("bottom: 0");
    expect(initialWing).toContain("max-height: calc(100% - 44px)");
  });

  it("focuses the main Tauri webview during startup for renderer shortcuts", () => {
    expect(appSource).toContain('import("@tauri-apps/api/window")');
    expect(appSource).toContain('import("@tauri-apps/api/webview")');
    expect(appSource).toContain("currentWindow.setFocus()");
    expect(appSource).toContain("currentWebview.setFocus()");
    expect(appSource).toContain("requestAnimationFrame");
    expect(appSource).toContain("Shift+Tab and");
  });

  it("keeps overlay window geometry persistence non-destructive", () => {
    // Stored geometry is the user's intent: viewport clamping happens only in
    // the render-time projection (fitToViewport), never in what is loaded,
    // patched, or persisted — a transient 0×0/small viewport must not squash
    // the remembered layout to minimum sizes.
    expect(overlaySource).toContain('from "../lib/overlayWins"');
    const loadWinsBody = overlaySource.slice(
      overlaySource.indexOf("function loadWins"),
      overlaySource.indexOf("function dateParts")
    );
    expect(loadWinsBody).toContain("mergeStoredWins");
    expect(loadWinsBody).not.toContain("fitWin(");
    expect(loadWinsBody).not.toContain("fitToViewport");
    // Both window kinds render through the projection.
    expect(overlaySource).toContain("rec={fitToViewport(wins[id], safeViewportHeight)}");
    expect(overlaySource).not.toContain("rec={wins[id]}");
    // No state writer runs geometry through the viewport fit.
    expect(overlaySource.match(/setWins\([^)]*fitWin/)).toBeNull();
    expect(overlaySource.match(/setWins\([^)]*fitToViewport/)).toBeNull();
  });

  it("defines each shared control class exactly once", () => {
    // A second equal-specificity definition later in the file silently wins
    // the cascade app-wide (the old PDF-toolbar `.seg-btn` block made the
    // canonical one dead code). Keep ONE definition per shared control.
    // Count rules whose ENTIRE selector list is exactly this selector —
    // multi-selector design-language rules (letter-spacing, radius, motion
    // groups) may mention these classes without redefining them.
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectorLists = [...noComments.matchAll(/(?:^|\})\s*([^{}@/]+?)\s*\{/g)].map((m) =>
      m[1].trim()
    );
    for (const selector of [".seg-btn", ".seg-btn.on", ".btn", ".btn.primary", ".btn.ghost", ".btn:disabled"]) {
      const defs = selectorLists.filter((s) => s === selector);
      expect(`${selector}: ${defs.length}`).toBe(`${selector}: 1`);
    }
  });

  it("keeps the graph canvas render pipeline corruption-proof", () => {
    // 1. One bad frame must never kill the rAF loop: the frame body is
    //    try/caught and the loop ALWAYS reschedules (a dead loop leaves the
    //    last — possibly never-painted — backing store composited as striped
    //    stale-surface garbage).
    const loopStart = graphView.indexOf("const loop = () => {");
    expect(loopStart).toBeGreaterThan(-1);
    const loopBody = graphView.slice(loopStart, graphView.indexOf("raf = requestAnimationFrame(loop);", loopStart));
    expect(loopBody).toContain("try {");
    expect(loopBody).toContain("frame();");
    expect(loopBody).toContain("catch");
    // 2. A freshly reallocated backing store is painted (cleared) immediately,
    //    never presented holding uninitialized rows.
    const applyStart = graphView.indexOf("const applyResize = () => {");
    const applyBody = graphView.slice(applyStart, graphView.indexOf("const ro = new ResizeObserver", applyStart));
    expect(applyBody).toContain("clearRect(0, 0, canvas.width, canvas.height)");
    // 3. The ResizeObserver's cheap CSS-stretch path is for SMALL deltas only;
    //    a large growth jump (the pane just opened) reallocs immediately
    //    instead of smearing a tiny bitmap into full-width bands for the
    //    debounce window.
    const roStart = graphView.indexOf("const ro = new ResizeObserver");
    const roBody = graphView.slice(roStart, graphView.indexOf("applyResize(); // size correctly on mount", roStart));
    expect(roBody).toContain("grewALot");
    expect(roBody).toMatch(/if \(grewALot\) \{[^}]*applyResize\(\);/);
    // 4. The graph canvas must never be force-promoted into its own transform
    //    layer (will-change/translateZ under data-accel) — a known WKWebView
    //    striped-garbage trigger with zero benefit for a 2D-API-painted canvas.
    const accelRule = css.slice(css.indexOf(':root[data-accel="on"]'));
    const accelSelectors = accelRule.slice(0, accelRule.indexOf("{"));
    expect(accelSelectors).not.toContain("graph-canvas");
  });

  it("makes Graph tear-off a drag interaction instead of a separate-window button", () => {
    expect(topBar).toContain('startViewDrag("graph"');
    expect(topBar).not.toContain("Open graph in a separate window");
    expect(appSource).not.toContain("popOutView");
    expect(appSource).not.toContain("Open in a new window");
    expect(appSource).not.toContain("popout-dock-btn");
    expect(css).not.toContain(".popout-dock-btn");
    expect(appSource).toContain("installNativeDragDock");
  });

  it("culls offscreen search-row paint without virtualizing results", () => {
    const body = ruleBody(/\.search-item\s*\{/);
    expect(body).toContain("content-visibility: auto");
    expect(body).toContain("contain-intrinsic-size: auto 58px");
  });

  describe("dock-side flip", () => {
    it("docks the side stack left by swapping center/dock grid columns", () => {
      expect(ruleBody(/\.layout\.dock-left\s*\{/)).toContain(
        "grid-template-columns: var(--sidebar-slot-w, 240px) var(--right-w, 380px) minmax(0, 1fr)"
      );
      expect(ruleBody(/\.layout\.dock-left\s*>\s*\.center\s*\{/)).toContain(
        "grid-column: 3"
      );
      expect(ruleBody(/\.layout\.dock-left\s*>\s*\.right-stack\s*\{/)).toContain(
        "grid-column: 2"
      );
    });

    it("zeros column 1 for the auto-hide + dock-left combo", () => {
      // The auto-hide sidebar is absolutely positioned, so column 1 must be 0
      // even when the dock is flipped to the left.
      expect(ruleBody(/\.layout\.auto-hide\.dock-left\s*\{/)).toContain(
        "0 var(--right-w, 380px) minmax(0, 1fr)"
      );
    });

    it("declares the dock-left base rule before the auto-hide override", () => {
      const base = css.search(/\.layout\.dock-left\s*\{/);
      const autoHide = css.search(/\.layout\.auto-hide\.dock-left\s*\{/);
      expect(base).toBeGreaterThan(0);
      expect(autoHide).toBeGreaterThan(base);
    });

    it("resets dock-left on narrow screens so a flipped dock leaves no gap", () => {
      const idx820 = css.search(/@media \(max-width: 820px\)/);
      const idx560 = css.search(/@media \(max-width: 560px\)/);
      expect(idx820).toBeGreaterThan(0);
      expect(idx560).toBeGreaterThan(idx820);

      const block820 = css.slice(idx820, idx560);
      expect(block820).toContain(".layout.dock-left");
      expect(block820).toContain("var(--sidebar-slot-w, 200px) minmax(0, 1fr)");
      expect(block820).toContain("grid-column: 2");

      const block560 = css.slice(idx560);
      expect(block560).toContain(".layout.dock-left");
      expect(block560).toContain("minmax(0, 1fr)");
      expect(block560).toContain("grid-column: 1");
    });
  });
});
