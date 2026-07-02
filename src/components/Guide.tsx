import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../store";
import { Modal } from "./Modal";

const TOURED_KEY = "mesa:toured";

interface Step {
  title: string;
  body: ReactNode;
  art: ReactNode;
}

// Small, theme-aware SVG vignettes (use currentColor / accent var).
const FolderArt = (
  <svg viewBox="0 0 64 48" className="guide-art" aria-hidden="true">
    <rect x="6" y="12" width="52" height="30" rx="5" fill="var(--bg-3)" />
    <path d="M6 16 q0-6 6-6 h12 l5 6 h23 q6 0 6 6" fill="var(--accent)" opacity="0.85" />
  </svg>
);
const LinkArt = (
  <svg viewBox="0 0 64 48" className="guide-art" aria-hidden="true">
    <circle cx="20" cy="24" r="7" fill="var(--accent)" />
    <circle cx="44" cy="24" r="7" fill="var(--bg-3)" stroke="var(--accent)" strokeWidth="2" />
    <line x1="27" y1="24" x2="37" y2="24" stroke="var(--accent)" strokeWidth="3" />
  </svg>
);
const GraphArt = (
  <svg viewBox="0 0 64 48" className="guide-art" aria-hidden="true">
    <line x1="32" y1="24" x2="14" y2="12" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5" />
    <line x1="32" y1="24" x2="52" y2="14" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5" />
    <line x1="32" y1="24" x2="20" y2="38" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5" />
    <line x1="32" y1="24" x2="48" y2="36" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5" />
    <circle cx="14" cy="12" r="3.5" fill="var(--accent)" />
    <circle cx="52" cy="14" r="3.5" fill="var(--accent)" />
    <circle cx="20" cy="38" r="3.5" fill="var(--accent)" />
    <circle cx="48" cy="36" r="3.5" fill="var(--accent)" />
    <circle cx="32" cy="24" r="6" fill="var(--accent)" className="guide-pulse" />
  </svg>
);
const SearchArt = (
  <svg viewBox="0 0 64 48" className="guide-art" aria-hidden="true">
    <circle cx="28" cy="22" r="11" fill="none" stroke="var(--accent)" strokeWidth="3" />
    <line x1="36" y1="30" x2="46" y2="40" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);
const SparkArt = (
  <svg viewBox="0 0 64 48" className="guide-art" aria-hidden="true">
    <path
      d="M32 8 l3 9 9 3 -9 3 -3 9 -3-9 -9-3 9-3 z"
      fill="var(--accent)"
      className="guide-pulse"
    />
    <circle cx="14" cy="36" r="2.5" fill="var(--accent)" opacity="0.7" />
    <circle cx="50" cy="34" r="2" fill="var(--accent)" opacity="0.6" />
  </svg>
);

const STEPS: Step[] = [
  {
    title: "Your vault workspace",
    body: (
      <>
        Pick any folder. Mesa keeps notes as plain files, opens documents and
        graph side by side, and lets views move, close, pop out, or fill the
        workspace.
      </>
    ),
    art: FolderArt,
  },
  {
    title: "Write and connect",
    body: (
      <>
        Type in the center. Link notes with <code>[[Note name]]</code>; backlinks
        and the graph update as you go.
      </>
    ),
    art: LinkArt,
  },
  {
    title: "The living graph",
    body: (
      <>
        Toggle <b>Graph</b> on the right. Nodes grow with connections and{" "}
        <b>glow as a note is edited</b>. Hover to peek, click to pop a note into
        its own window, or move it into the workspace.
      </>
    ),
    art: GraphArt,
  },
  {
    title: "Find anything fast",
    body: (
      <>
        <b>⌘P</b> jumps to any note, <b>⌘⇧F</b> searches every note,{" "}
        <b>j/k/h/l</b> move like Vim, and <b>#tags</b> live in the sidebar.
      </>
    ),
    art: SearchArt,
  },
  {
    title: "Overlay, Pi, and sync",
    body: (
      <>
        <b>Shift+Tab</b> opens the overlay. Pi is a vault terminal there and can
        be placed into the workspace. Sync discovers nearby Mesa devices and
        still requires the sync key.
      </>
    ),
    art: SparkArt,
  },
];

function StepCard({ step }: { step: Step }) {
  return (
    <div className="guide-card-inner" key={step.title}>
      <div className="guide-art-wrap">{step.art}</div>
      <h2 className="guide-title">{step.title}</h2>
      <p className="guide-body">{step.body}</p>
    </div>
  );
}

/** First-run guided tour: the bare essentials, animated, skippable. */
export function Tour() {
  const open = useAppStore((s) => s.tourOpen);
  const setOpen = useAppStore((s) => s.setTourOpen);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  const finish = () => {
    try {
      localStorage.setItem(TOURED_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  if (!open) return null;
  const last = i === STEPS.length - 1;
  return (
    <Modal onClose={finish} className="guide">
      <StepCard step={STEPS[i]} />
      <div className="guide-dots">
        {STEPS.map((_, k) => (
          <span key={k} className={"guide-dot" + (k === i ? " on" : "")} />
        ))}
      </div>
      <div className="guide-actions">
        <button className="btn ghost" onClick={finish}>
          Skip
        </button>
        <div className="guide-actions-right">
          {i > 0 && (
            <button className="btn" onClick={() => setI((v) => v - 1)}>
              Back
            </button>
          )}
          {last ? (
            <button className="btn primary" onClick={finish}>
              Start writing
            </button>
          ) : (
            <button className="btn primary" onClick={() => setI((v) => v + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Help: the same guide, browsable any time from the ? button. */
export function HelpModal() {
  const open = useAppStore((s) => s.helpOpen);
  const setOpen = useAppStore((s) => s.setHelpOpen);
  if (!open) return null;
  return (
    <Modal onClose={() => setOpen(false)} className="guide help">
      <header className="modal-head">
        <span>How Mesa works</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>
      <div className="guide-list">
        {STEPS.map((s) => (
          <div className="guide-list-item" key={s.title}>
            <div className="guide-art-wrap small">{s.art}</div>
            <div>
              <div className="guide-title small">{s.title}</div>
              <p className="guide-body">{s.body}</p>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function hasToured(): boolean {
  try {
    return localStorage.getItem(TOURED_KEY) === "1";
  } catch {
    return false;
  }
}
