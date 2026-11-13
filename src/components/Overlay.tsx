import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { localTime } from "../lib/daily";
import { IN_TAURI } from "../lib/vault";
import { DeepResearchPanel } from "./DeepResearchPanel";
import { DeepResearchPhaseChip } from "./DeepResearchPhaseChip";
import { OVERLAY_BOTTOM, fitWin, mergeStoredWins } from "../lib/overlayWins";
import { readLocalNote, writeLocalNote } from "../lib/localNotes";
import { SearchSurface } from "./SearchSurface";
import { TasksPanel } from "./TasksModal";
import { claimKeyboardShortcut } from "../lib/shortcuts";
import { OverlayCalendar } from "./overlay/OverlayCalendar";
import { OverlayHelp, OverlayTour } from "./overlay/OverlayGuide";
import { OverlaySettings } from "./overlay/OverlaySettings";
import { trapOverlayFocus } from "./overlay/trapOverlayFocus";
import { Whiteboard } from "./overlay/Whiteboard";
import { type WinRec, PiOverlayWindow, FloatingWindow } from "./overlay/OverlayWindows";
import { Scratchpad, Gallery } from "./overlay/OverlayBodies";

const OVERLAY_TOURED_KEY = "mesa:overlayToured";
const OVERLAY_FADE_MS = 240;
const WINS_KEY = "mesa:overlayWins";

type WinId =
  | "calendar"
  | "search"
  | "agent"
  | "research"
  | "tasks"
  | "scratch"
  | "whiteboard"
  | "gallery"
  | "settings";

type Wins = Record<WinId, WinRec>;

const DEFAULT_WINS: Wins = {
  calendar: { open: true, x: 90, y: 76, w: 760, h: 640 },
  search: { open: false, x: 140, y: 96, w: 900, h: 560 },
  agent: { open: false, x: 150, y: 86, w: 720, h: 680 },
  research: { open: false, x: 170, y: 92, w: 780, h: 640 },
  tasks: { open: false, x: 180, y: 96, w: 860, h: 600 },
  scratch: { open: false, x: 820, y: 100, w: 340, h: 400 },
  whiteboard: { open: false, x: 220, y: 130, w: 640, h: 460 },
  gallery: { open: false, x: 280, y: 96, w: 640, h: 520 },
  settings: { open: false, x: 250, y: 120, w: 560, h: 520 },
};

const DOCK: { id: WinId; label: string; icon: string }[] = [
  { id: "calendar", label: "Calendar", icon: "▦" },
  { id: "search", label: "Search", icon: "⌕" },
  { id: "agent", label: "Pi", icon: "π" },
  { id: "research", label: "Research", icon: "⌬" },
  { id: "tasks", label: "Tasks", icon: "☑" },
  { id: "scratch", label: "Scratchpad", icon: "✎" },
  { id: "whiteboard", label: "Whiteboard", icon: "▭" },
  { id: "gallery", label: "Gallery", icon: "❖" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

/** Render-time projection into the current viewport. NEVER write the result
 *  back into `wins` — the stored geometry is the user's intent, and a
 *  transiently tiny viewport (0×0 during startup, a briefly shrunken OS
 *  window) must not permanently squash the remembered layout. */
function fitToViewport(rec: WinRec, viewportHeight?: number): WinRec {
  if (typeof window === "undefined") return rec;
  return fitWin(rec, { width: window.innerWidth, height: viewportHeight ?? window.innerHeight });
}
const lsGet = (key: string): string => readLocalNote(key);
/** Layout/flag keys only. Losing an overlay window position or a "seen the
 *  tour" flag is invisible; losing what the user WROTE is not, so the
 *  Scratchpad and Whiteboard drafts report their failures instead of using this. */
function lsSet(key: string, val: string): void {
  writeLocalNote(key, val);
}
function loadWins(): Wins {
  try {
    return mergeStoredWins(DEFAULT_WINS, JSON.parse(lsGet(WINS_KEY) || "{}"));
  } catch {
    return mergeStoredWins(DEFAULT_WINS, {});
  }
}

/** Live clock for the overlay header. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="ov-clock">
      <span className="ov-clock-time">{localTime(now)}</span>
      <span className="ov-clock-date">
        {now.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
      </span>
    </div>
  );
}

// Window bodies take only stable props, so a frame-only update (drag, resize,
// focus order) re-renders the FloatingWindow frame and not its body.
const CalendarBody = memo(OverlayCalendar);
const SearchBody = memo(SearchSurface);
const ResearchBody = memo(DeepResearchPanel);
const TasksBody = memo(TasksPanel);
const ScratchBody = memo(Scratchpad);
const WhiteboardBody = memo(Whiteboard);
const SettingsBody = memo(OverlaySettings);
const GalleryBody = memo(Gallery);

const WIN_TITLE: Record<WinId, string> = {
  calendar: "Calendar",
  search: "Search",
  agent: "Pi agent",
  research: "Deep Research",
  tasks: "Tasks",
  scratch: "Scratchpad",
  whiteboard: "Whiteboard",
  gallery: "Gallery",
  settings: "Overlay settings",
};

/** Mesa overlay: dim backdrop, bottom dock, floating windows. */
export function Overlay() {
  const open = useAppStore((s) => s.overlayOpen);
  const animations = useAppStore((s) => s.settings.animations);
  const setOpen = useAppStore((s) => s.setOverlayOpen);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);
  const overlayWindowRequest = useAppStore((s) => s.overlayWindowRequest);
  const openDeepResearch = useAppStore((s) => s.openDeepResearch);
  const deepResearchSurface = useAppStore((s) => s.deepResearchSurface);
  const setDeepResearchSurface = useAppStore((s) => s.setDeepResearchSurface);
  const searchSeed = useAppStore((s) => s.searchSeed);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [safeViewportHeight, setSafeViewportHeight] = useState(() =>
    typeof window === "undefined" ? 720 : window.innerHeight
  );
  const [wins, setWins] = useState<Wins>(() => loadWins());
  const [order, setOrder] = useState<WinId[]>([
    "scratch",
    "whiteboard",
    "gallery",
    "settings",
    "search",
    "agent",
    "research",
    "tasks",
    "calendar",
  ]);
  useLayoutEffect(() => {
    if (!open) return;
    const dock = dockRef.current;
    if (!dock) return;
    const measure = () => {
      const dockTop = dock.getBoundingClientRect().top;
      // fitWin reserves OVERLAY_BOTTOM below its effective viewport. Shift
      // that viewport upward when the dock wraps so every projected window,
      // including Pi's downward composer, ends above the actual dock.
      setSafeViewportHeight(
        Math.min(window.innerHeight, Math.max(OVERLAY_BOTTOM + 220, dockTop - 8 + OVERLAY_BOTTOM))
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  const [renderOverlay, setRenderOverlay] = useState(open);
  const [, setViewportTick] = useState(0);
  const [visible, setVisible] = useState(open);
  const [showTour, setShowTour] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    lsSet(WINS_KEY, JSON.stringify(wins));
  }, [wins]);
  useEffect(() => {
    if (open) setRenderOverlay(true);
  }, [open]);
  useEffect(() => {
    if (!renderOverlay) return;
    if (open) {
      if (!animations) {
        setVisible(true);
        return;
      }
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    if (!animations) {
      setRenderOverlay(false);
      return;
    }
    const t = setTimeout(() => setRenderOverlay(false), OVERLAY_FADE_MS);
    return () => clearTimeout(t);
  }, [animations, open, renderOverlay]);
  useEffect(() => {
    if (open && !lsGet(OVERLAY_TOURED_KEY)) setShowTour(true);
  }, [open]);
  // Store-level callers can request a specific overlay window (with optional
  // geometry) from anywhere in the app: search routes here while the overlay
  // is open, and Pi's Deep Research wing can detach into this floating window.
  useEffect(() => {
    if (!overlayWindowRequest) return;
    const { id, rec } = overlayWindowRequest;
    setWins((w) => ({
      ...w,
      [id]: {
        ...w[id],
        ...(rec ?? {}),
        open: true,
      },
    }));
    setOrder((o) => [...o.filter((x) => x !== id), id]);
  }, [overlayWindowRequest]);
  useEffect(() => {
    if (wins.research.open && deepResearchSurface === "overlay") {
      openDeepResearch(false);
    }
  }, [deepResearchSurface, wins.research.open, openDeepResearch]);
  useEffect(() => {
    // Null means closed or an incoming overlay claim, not "another host owns
    // it"; only an explicit different owner may displace this stored window.
    if (!deepResearchSurface || deepResearchSurface === "overlay" || !wins.research.open) return;
    setWins((current) => ({
      ...current,
      research: { ...current.research, open: false },
    }));
  }, [deepResearchSurface, wins.research.open]);
  useEffect(() => {
    if (open) return;
    if (wins.research.open) {
      setWins((current) => ({
        ...current,
        research: { ...current.research, open: false },
      }));
    }
    if (deepResearchSurface === "overlay") setDeepResearchSurface(null);
  }, [deepResearchSurface, open, setDeepResearchSurface, wins.research.open]);
  useEffect(() => {
    if (!open) return;
    // Re-render on viewport changes so the render-time fitToViewport
    // projection tracks the new size; the stored geometry is left alone.
    const onResize = () => setViewportTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if ((e.target as Element | null)?.closest?.("[data-escape-layer]")) return;
        claimKeyboardShortcut(e);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open, setOpen]);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      restoreFocus.current = active instanceof HTMLElement ? active : null;
      const raf = requestAnimationFrame(() => {
        overlayRef.current?.querySelector<HTMLElement>(".ov-close")?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    restoreFocus.current?.focus();
    restoreFocus.current = null;
  }, [open]);

  const focus = useCallback((id: WinId) => setOrder((o) => [...o.filter((x) => x !== id), id]), []);
  const openWindow = useCallback((id: WinId) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], open: true } }));
    focus(id);
  }, [focus]);
  const resetOverlayLayout = useCallback(() => {
    setWins(mergeStoredWins(DEFAULT_WINS, {}));
    setOrder(["scratch", "whiteboard", "gallery", "settings", "search", "agent", "research", "tasks", "calendar"]);
  }, []);
  const closeOverlay = useCallback(() => setOpen(false), [setOpen]);
  const openAgentWindow = useCallback(() => openWindow("agent"), [openWindow]);

  if (!renderOverlay) return null;

  const patch = (id: WinId, p: Partial<WinRec>) =>
    setWins((w) => ({ ...w, [id]: { ...w[id], ...p } }));
  const toggle = (id: WinId) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], open: !w[id].open } }));
    focus(id);
  };
  const content = (id: WinId) =>
    id === "calendar" ? (
      <CalendarBody />
    ) : id === "search" ? (
      <SearchBody initialQuery={searchSeed} onClose={closeOverlay} onAgent={openAgentWindow} />
    ) : id === "research" ? (
      <ResearchBody />
    ) : id === "tasks" ? (
      <TasksBody onPick={closeOverlay} />
    ) : id === "scratch" ? (
      <ScratchBody />
    ) : id === "whiteboard" ? (
      <WhiteboardBody />
    ) : id === "settings" ? (
      <SettingsBody onReset={resetOverlayLayout} />
    ) : (
      <GalleryBody />
    );

  return (
    <div
      ref={overlayRef}
      className={"overlay" + (visible ? " visible" : "")}
      role="dialog"
      aria-modal="true"
      aria-label="Mesa overlay"
      onKeyDown={trapOverlayFocus}
    >
      <header className="ov-head">
        <Clock />
        <span className="ov-head-hint">
          Back to work · <kbd>Shift</kbd>+<kbd>Tab</kbd>
        </span>
        <button className="btn icon ov-close" onClick={() => setOpen(false)} aria-label="Close overlay">
          ×
        </button>
      </header>

      {(Object.keys(wins) as WinId[]).map((id) =>
        !wins[id].open || (id === "research" && deepResearchSurface !== "overlay") ? null : id === "agent" ? (
          <PiOverlayWindow
            key={id}
            rec={fitToViewport(wins[id], safeViewportHeight)}
            z={10 + order.indexOf(id)}
            onChange={(p) => patch(id, p)}
            onClose={() => toggle(id)}
            onFocus={() => focus(id)}
            onPlaceInWorkspace={() => {
              moveViewToRight("agent");
              setOpen(false);
            }}
          />
        ) : (
          <FloatingWindow
            key={id}
            title={WIN_TITLE[id]}
            accessory={id === "research" ? <DeepResearchPhaseChip /> : undefined}
            onTearOff={id === "research" && IN_TAURI ? (placement) => { void useAppStore.getState().openResearchWindow(placement); } : undefined}
            rec={fitToViewport(wins[id], safeViewportHeight)}
            z={10 + order.indexOf(id)}
            onChange={(p) => patch(id, p)}
            onClose={() => {
              if (id === "research") setDeepResearchSurface(null);
              toggle(id);
            }}
            onFocus={() => focus(id)}
          >
            {content(id)}
          </FloatingWindow>
        )
      )}

      <div className="ov-dock" ref={dockRef} data-native-webview-occluder="">
        {DOCK.map((d) => (
          <button
            key={d.id}
            className={
              "ov-dock-btn" +
              ((d.id === "research" ? deepResearchSurface === "overlay" : wins[d.id].open)
                ? " on"
                : "")
            }
            onClick={() => {
              if (d.id === "research") {
                if (deepResearchSurface === "overlay" && wins.research.open) {
                  setDeepResearchSurface(null);
                  patch("research", { open: false });
                } else {
                  openDeepResearch(false);
                  setDeepResearchSurface("overlay");
                  openWindow("research");
                }
                return;
              }
              toggle(d.id);
            }}
            title={d.label}
            aria-label={`${d.label} window`}
            aria-pressed={d.id === "research" ? deepResearchSurface === "overlay" : wins[d.id].open}
          >
            <span className="ov-dock-icon" aria-hidden="true">{d.icon}</span>
            <span className="ov-dock-label">{d.label}</span>
          </button>
        ))}
      </div>

      <button
        className="ov-help-button"
        data-native-webview-occluder=""
        onClick={() => setShowHelp(true)}
        aria-label="Mesa guide"
        title="Mesa guide"
      >
        ?
      </button>

      {showTour && (
        <OverlayTour
          onDone={() => {
            lsSet(OVERLAY_TOURED_KEY, "1");
            setShowTour(false);
          }}
        />
      )}
      {showHelp && (
        <OverlayHelp
          onClose={() => setShowHelp(false)}
          onTour={() => {
            setShowHelp(false);
            setShowTour(true);
          }}
        />
      )}
    </div>
  );
}
