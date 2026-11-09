import { useEffect, useRef, useState } from "react";
import { trapOverlayFocus } from "./trapOverlayFocus";

const OVERLAY_TOUR_STEPS = [
  {
    title: "Start with the vault workspace",
    body:
      "Mesa is a constrained desktop for one vault. The first view you open fills the workspace. Additional views take open space before anything gets subdivided.",
    detail:
      "Default rhythm: document first, graph/preview beside it, then stacked utility panes only when the main workspace is already occupied.",
  },
  {
    title: "Move panes like windows",
    body:
      "Drag any view header to move it. Drop on the workspace to snap it, or drag to a workspace edge and release to tear it into a native window.",
    detail:
      "The goal is spatial memory: document, Preview, Graph, Tasks, and Pi are all views that can move rather than fixed app furniture.",
  },
  {
    title: "Learn the keyboard path",
    body:
      "Use j/k to move through notes, h/l to move focus, / for search, gg/G for top/bottom, and Ctrl/Cmd+W then q to close the focused view.",
    detail:
      "These are Vim-shaped commands without forcing you into Vim. They make navigation fast while staying discoverable.",
  },
  {
    title: "Use the overlay as a control room",
    body:
      "Shift+Tab opens Calendar, Search, Pi, Tasks, Scratchpad, Whiteboard, Gallery, and overlay Settings. Each overlay window can move, resize, close, and reset.",
    detail:
      "Esc closes the overlay. The bottom dock is for temporary tools, not permanent chrome.",
  },
  {
    title: "Pi is a terminal, not a chat panel",
    body:
      "Cmd/Ctrl+Left Shift+Space opens Pi directly. Pi starts in the vault, sees path-only Mesa context, and provider setup stays inside the Pi CLI.",
    detail:
      "Mesa does not burn provider tokens in the background. It only gives Pi where you are, not the entire vault contents.",
  },
  {
    title: "Sync stays simple by default",
    body:
      "Turn Sync on, set one sync key, receive on one device, and add nearby devices when they appear. Tailscale names and manual addresses remain advanced options.",
    detail:
      "Discovery is metadata-only. File reads and writes still require the sync key.",
  },
  {
    title: "Recover from any layout",
    body:
      "Use the top-left vault switcher to change vaults, Search to find files, overlay Settings to reset floating windows, and close buttons to let remaining views fill space.",
    detail:
      "Empty workspace states are valid. Opening the next view should fill the workspace again.",
  },
];

export function OverlayTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const current = OVERLAY_TOUR_STEPS[step];
  const last = step === OVERLAY_TOUR_STEPS.length - 1;
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => restoreFocus.current?.focus();
  }, []);
  return (
    <div
      ref={rootRef}
      className="ov-tour"
      data-native-webview-occluder=""
      role="dialog"
      aria-modal="true"
      aria-label="Mesa overlay tour"
      tabIndex={-1}
      onKeyDown={trapOverlayFocus}
    >
      <div className="ov-tour-card">
        <div className="ov-tour-mark">✦</div>
        <div className="ov-tour-count">
          {step + 1} / {OVERLAY_TOUR_STEPS.length}
        </div>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        <p className="ov-tour-detail">{current.detail}</p>
        <p className="ov-tour-tip">
          <kbd>Shift</kbd>+<kbd>Tab</kbd> opens Mesa's overlay. <kbd>Esc</kbd> closes it.
        </p>
        <div className="ov-tour-dots" aria-hidden="true">
          {OVERLAY_TOUR_STEPS.map((_, i) => (
            <span key={i} className={i === step ? "on" : ""} />
          ))}
        </div>
        <div className="ov-tour-actions">
          <button className="btn ghost" onClick={onDone}>
            Skip
          </button>
          <div className="guide-actions-right">
            {step > 0 && (
              <button className="btn" onClick={() => setStep((v) => v - 1)}>
                Back
              </button>
            )}
            <button
              className="btn primary"
              onClick={() => (last ? onDone() : setStep((v) => v + 1))}
            >
              {last ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OverlayHelp({
  onClose,
  onTour,
}: {
  onClose: () => void;
  onTour: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => restoreFocus.current?.focus();
  }, []);
  return (
    <div
      ref={rootRef}
      className="ov-help-layer"
      data-native-webview-occluder=""
      role="dialog"
      aria-modal="true"
      aria-label="Mesa guide"
      tabIndex={-1}
      onKeyDown={trapOverlayFocus}
    >
      <div className="ov-help-card">
        <header className="ov-help-head">
          <div>
            <div className="ov-help-kicker">Mesa guide</div>
            <h2>How Mesa works</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close guide">
            ×
          </button>
        </header>
        <div className="ov-help-grid">
          <section>
            <h3>Workspace model</h3>
            <p>
              Mesa is a constrained desktop for one vault. It opens as document plus
              graph, but document, preview, graph, tasks, and Pi can be snapped,
              closed, popped out, or docked back.
            </p>
          </section>
          <section>
            <h3>Moving views</h3>
            <p>
              Drag a view header to another workspace region to swap or stack it.
              Drag outside Mesa to pop out. Use the small terminal/grid control to
              place Pi back into the workspace.
            </p>
          </section>
          <section>
            <h3>Keyboard path</h3>
            <p>
              <kbd>j</kbd>/<kbd>k</kbd> move through notes, <kbd>h</kbd>/<kbd>l</kbd>{" "}
              move focus, <kbd>/</kbd> searches, <kbd>g</kbd><kbd>g</kbd> jumps top,
              and <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd> then <kbd>q</kbd> closes.
            </p>
          </section>
          <section>
            <h3>Pi terminal</h3>
            <p>
              <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Left Shift</kbd>+<kbd>Space</kbd>{" "}
              opens the dedicated Pi overlay. Pi runs in the vault as a PTY-backed
              terminal and receives path-only Mesa context as environment variables.
            </p>
          </section>
          <section>
            <h3>Mesa overlay</h3>
            <p>
              <kbd>Shift</kbd>+<kbd>Tab</kbd> opens calendar, search, Pi, scratchpad,
              whiteboard, gallery, and settings. Floating windows can be moved,
              resized, closed, and reset from overlay settings.
            </p>
          </section>
          <section>
            <h3>Sync boundary</h3>
            <p>
              LAN discovery advertises device name and address only. File reads and
              writes still require the sync key. The master Sync switch
              stops discovery, listening, manual sync, and schedules.
            </p>
          </section>
          <section>
            <h3>Saved webpages</h3>
            <p>
              HTML files render as local saved pages with sibling asset folders,
              matching browser behavior. Source mode stays available when you need
              to inspect the captured file.
            </p>
          </section>
          <section>
            <h3>When lost</h3>
            <p>
              Use overlay settings to reset floating windows, the top-left vault
              switcher to change vaults, and the sidebar plus search to recover
              from any empty workspace state.
            </p>
          </section>
        </div>
        <footer className="ov-help-foot">
          <button className="btn" onClick={onTour}>
            Start guided tour
          </button>
          <button className="btn primary" onClick={onClose}>
            Back to overlay
          </button>
        </footer>
      </div>
    </div>
  );
}
