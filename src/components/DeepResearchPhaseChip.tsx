import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store";
import type { DeepResearchRunState } from "../store";

function phaseLabel(run: DeepResearchRunState): string {
  if (["planning", "researching", "synthesizing"].includes(run.phase)) {
    if (run.piTurnEnded) return "Pi turn ended — report not accepted";
    if (run.finishRejection) return "Correcting rejected report…";
  }
  switch (run.phase) {
    case "idle": return "Ready";
    case "planning": return run.launchStage === "starting-pi" || run.launchStage === "restarting-pi"
      ? "Starting Pi…"
      : "Planning sub-questions…";
    case "researching": return run.launchStage === "waiting-for-model"
      ? "Waiting for Pi…"
      : "Researching sources…";
    case "synthesizing": return "Drafting report…";
    case "review": return "Review proposed changes";
    case "applying": return "Applying changes…";
    case "done": return "Done";
    case "cancelled": return "Cancelled";
    case "error": return "Error";
  }
}

/**
 * Live phase chip for a host title bar. Keep this small module separate from
 * the research panel so detached-window startup does not load the full
 * research graph, source cards, and review UI just to paint the bar.
 */
export function DeepResearchPhaseChip() {
  return <DeepResearchPhaseChipWithRun />;
}

export function DeepResearchPhaseChipWithRun({
  runOverride = null,
}: {
  runOverride?: DeepResearchRunState | null;
}) {
  const storeRun = useAppStore((s) => s.deepResearch);
  const run = runOverride ?? storeRun;
  const [contextOpen, setContextOpen] = useState(false);
  const contextPinnedRef = useRef(false);
  const [contextPopoverPosition, setContextPopoverPosition] = useState({
    left: 8,
    top: 8,
    ready: false,
  });
  const contextAnchorRef = useRef<HTMLSpanElement | null>(null);
  const contextPopoverRef = useRef<HTMLSpanElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const context = run?.context;
  const measureContextPopover = () => {
    const anchor = contextAnchorRef.current;
    const popover = contextPopoverRef.current;
    if (!anchor || !popover) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const edge = 8;
    const gap = 8;
    const left = Math.max(
      edge,
      Math.min(anchorRect.right - popoverRect.width, window.innerWidth - popoverRect.width - edge)
    );
    const below = anchorRect.bottom + gap;
    const top = below + popoverRect.height <= window.innerHeight - edge
      ? below
      : Math.max(edge, anchorRect.top - gap - popoverRect.height);
    setContextPopoverPosition({ left, top, ready: true });
  };
  useLayoutEffect(() => {
    if (!contextOpen || !context) return;
    measureContextPopover();
    const onViewportChange = () => measureContextPopover();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [context, contextOpen]);
  const openContext = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setContextPopoverPosition((current) => ({ ...current, ready: false }));
    setContextOpen(true);
  };
  const closeContext = () => {
    if (contextPinnedRef.current) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setContextOpen(false), 160);
  };
  const togglePinnedContext = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    contextPinnedRef.current = !contextPinnedRef.current;
    if (contextPinnedRef.current) openContext();
    else setContextOpen(false);
  };
  useEffect(() => {
    contextPinnedRef.current = false;
    setContextOpen(false);
  }, [run?.runId]);
  if (!run) return null;
  return (
    <span
      ref={contextAnchorRef}
      className="dr-phase-context"
      onMouseEnter={openContext}
      onMouseLeave={closeContext}
    >
      <button
        type="button"
        className={"dr-phase dr-phase-" + run.phase}
        data-escape-layer=""
        aria-expanded={contextOpen}
        aria-label={context ? `${phaseLabel(run)}. Show Context sent to Pi.` : phaseLabel(run)}
        title={context ? "Show Context sent to Pi" : phaseLabel(run)}
        onClick={togglePinnedContext}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          contextPinnedRef.current = false;
          setContextOpen(false);
        }}
      >
        <span>{phaseLabel(run)}</span>
        {context && <span className="dr-phase-context-cue" aria-hidden="true">Context</span>}
      </button>
      {/* Keep this small informational overlay passive so the live native
          browser remains visible beneath it when their rectangles touch. */}
      {context && contextOpen && createPortal(
        <span
          ref={contextPopoverRef}
          className="dr-context-popover"
          role="status"
          style={{
            left: contextPopoverPosition.left,
            top: contextPopoverPosition.top,
            visibility: contextPopoverPosition.ready ? "visible" : "hidden",
          }}
          onMouseEnter={openContext}
          onMouseLeave={closeContext}
        >
          <strong>Context sent to Pi</strong>
          <span>{context.summary} · {context.scope} scope</span>
          <span className="dr-context-popover-notes">
            {context.notes.slice(0, 8).map((note) => (
              <span key={note.relPath} className="dr-chip" title={note.via.join(", ")}>
                {note.relPath}
              </span>
            ))}
            {context.notes.length > 8 && <span className="dr-chip dr-chip-more">+{context.notes.length - 8} more</span>}
          </span>
          {context.truncated && <span className="dr-context-trunc">{context.omittedNotes} related note{context.omittedNotes === 1 ? "" : "s"} omitted.</span>}
        </span>,
        document.body
      )}
    </span>
  );
}
