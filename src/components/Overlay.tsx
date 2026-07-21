import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, THEMES } from "../store";
import {
  localISO,
  monthMatrix,
  weekMatrix,
  MONTH_NAMES,
  holidaysForYear,
  type CalEvent,
} from "../lib/daily";
import { IN_TAURI, isImageExt, urlForPath } from "../lib/vault";
import {
  claimKeyboardShortcut,
  isPlainShiftTab,
  isTextEntryTarget,
} from "../lib/shortcuts";
import { detachedWindowPlacement, isWindowTearOffPoint } from "../lib/windowTearOff";
import { AgentSurface } from "./AgentPanel";
import { DeepResearchPanel, DeepResearchPhaseChip } from "./DeepResearchPanel";
import { fitWin, mergeStoredWins, type OverlayWinRec } from "../lib/overlayWins";
import { SearchSurface } from "./SearchSurface";
import { TasksPanel } from "./TasksModal";
import { parseTasks, type TaskItem } from "../lib/tasks";

const OVERLAY_TOURED_KEY = "mesa:overlayToured";
const OVERLAY_FADE_MS = 240;
const SCRATCH_PREFIX = "mesa:scratch:";
const WHITEBOARD_KEY = "mesa:whiteboard";
const WINS_KEY = "mesa:overlayWins";
const SUN_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
type CalView = "day" | "week" | "month" | "year";

type WinRec = OverlayWinRec;
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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Render-time projection into the current viewport. NEVER write the result
 *  back into `wins` — the stored geometry is the user's intent, and a
 *  transiently tiny viewport (0×0 during startup, a briefly shrunken OS
 *  window) must not permanently squash the remembered layout. */
function fitToViewport(rec: WinRec): WinRec {
  if (typeof window === "undefined") return rec;
  return fitWin(rec, { width: window.innerWidth, height: window.innerHeight });
}
function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}
function loadWins(): Wins {
  try {
    return mergeStoredWins(DEFAULT_WINS, JSON.parse(lsGet(WINS_KEY) || "{}"));
  } catch {
    return mergeStoredWins(DEFAULT_WINS, {});
  }
}
function dateParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}
function shiftISO(iso: string, days = 0, months = 0, years = 0): string {
  const [y, m, d] = dateParts(iso);
  const dt = new Date(y, m - 1, d);
  if (days) dt.setDate(dt.getDate() + days);
  if (months) dt.setMonth(dt.getMonth() + months);
  if (years) dt.setFullYear(dt.getFullYear() + years);
  return localISO(dt);
}

/** Live clock for the overlay header. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return (
    <div className="ov-clock">
      <span className="ov-clock-time">
        {hh}:{mm}
      </span>
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

/**
 * The Steam-overlay Pi window. Unlike the other overlay windows it does NOT
 * use the generic FloatingWindow chrome: Pi's combined title bar (label,
 * terminal status, research/workspace/browser/close tools) IS the window bar,
 * exactly like the dedicated Pi overlay and the popped-out Pi OS window — so
 * every floating Pi surface looks and behaves the same. Dragging that bar
 * moves the window; dragging it to a workspace edge and releasing tears Pi
 * into a native OS window (same gesture as everywhere else). Position/size
 * persist with the other overlay windows.
 */
/**
 * Shared bottom-right resize gesture for overlay windows. Grows the window
 * from its current size, clamped to `minW`/`minH` and the viewport, with
 * text selection suppressed for the drag duration.
 */
function startOverlayResize(
  e: React.PointerEvent,
  rec: WinRec,
  minW: number,
  minH: number,
  onChange: (patch: Partial<WinRec>) => void,
  onFocus: () => void
): void {
  e.stopPropagation();
  e.preventDefault();
  onFocus();
  const sx = e.clientX;
  const sy = e.clientY;
  const sw = rec.w;
  const sh = rec.h;
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  const move = (ev: PointerEvent) => {
    onChange({
      w: clamp(sw + (ev.clientX - sx), minW, window.innerWidth - rec.x - 8),
      h: clamp(sh + (ev.clientY - sy), minH, window.innerHeight - rec.y - 8),
    });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.userSelect = prevUserSelect;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function PiOverlayWindow({
  rec,
  z,
  onChange,
  onClose,
  onFocus,
  onPlaceInWorkspace,
}: {
  rec: WinRec;
  z: number;
  onChange: (patch: Partial<WinRec>) => void;
  onClose: () => void;
  onFocus: () => void;
  onPlaceInWorkspace: () => void;
}) {
  const openAgentWindow = useAppStore((s) => s.openAgentWindow);
  const [tearOffArmed, setTearOffArmed] = useState(false);
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onFocus();
    // Pointer capture keeps the drag alive as it crosses the webview edge,
    // which is what makes release-to-native-window tear-off possible.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort across system webviews */
    }
    const ox = e.clientX - rec.x;
    const oy = e.clientY - rec.y;
    const w = rec.w;
    const h = rec.h;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      setTearOffArmed(
        isWindowTearOffPoint(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight)
      );
      onChange({
        x: clamp(ev.clientX - ox, 4, window.innerWidth - 80),
        y: clamp(ev.clientY - oy, 56, window.innerHeight - 96),
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = prevUserSelect;
      setTearOffArmed(false);
      if (
        IN_TAURI &&
        isWindowTearOffPoint(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight)
      ) {
        onClose();
        void openAgentWindow(
          detachedWindowPlacement({
            screenX: ev.screenX,
            screenY: ev.screenY,
            grabOffsetX: ox,
            grabOffsetY: oy,
            width: w,
            height: h,
          })
        );
      }
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = prevUserSelect;
      setTearOffArmed(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };
  const startResize = (e: React.PointerEvent) =>
    startOverlayResize(e, rec, 420, 320, onChange, onFocus);
  return (
    <div
      className={"ov-win pi-ov-win" + (tearOffArmed ? " tear-off-armed" : "")}
      style={{ left: rec.x, top: rec.y, width: rec.w, height: rec.h, zIndex: z }}
      onPointerDown={onFocus}
    >
      <AgentSurface
        embedded
        browserSlideOut
        windowTitle="Pi agent"
        onTitleBarPointerDown={startDrag}
        onClose={onClose}
        onPlaceInWorkspace={onPlaceInWorkspace}
      />
      <div className="ov-win-resize" onPointerDown={startResize} aria-hidden="true" />
    </div>
  );
}

/** A draggable, resizable, closable floating window inside the overlay. */
function FloatingWindow({
  title,
  accessory,
  rec,
  z,
  onChange,
  onClose,
  onFocus,
  children,
}: {
  title: string;
  /** Optional live status rendered in the ONE window bar (e.g. the Deep
   *  Research phase chip) — panels must not stack a second in-body header. */
  accessory?: React.ReactNode;
  rec: WinRec;
  z: number;
  onChange: (patch: Partial<WinRec>) => void;
  onClose: () => void;
  onFocus: () => void;
  children: React.ReactNode;
}) {
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".ov-win-close")) return;
    // Prevent the drag from starting a text-selection gesture (the overlay
    // windows live over arbitrary content and Safari/WebKit will otherwise
    // highlight text while moving them).
    e.preventDefault();
    onFocus();
    const ox = e.clientX - rec.x;
    const oy = e.clientY - rec.y;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      onChange({
        x: clamp(ev.clientX - ox, 4, window.innerWidth - 80),
        y: clamp(ev.clientY - oy, 56, window.innerHeight - 96),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = prevUserSelect;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startResize = (e: React.PointerEvent) =>
    startOverlayResize(e, rec, 280, 180, onChange, onFocus);
  return (
    <div
      className="ov-win"
      style={{ left: rec.x, top: rec.y, width: rec.w, height: rec.h, zIndex: z }}
      onPointerDown={onFocus}
    >
      <div className="ov-win-bar" onPointerDown={startDrag}>
        <span className="ov-win-title">{title}</span>
        {accessory}
        <button className="ov-win-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="ov-win-body">{children}</div>
      <div className="ov-win-resize" onPointerDown={startResize} aria-hidden="true" />
    </div>
  );
}

/** Apple-Calendar-style surface: day/week/month/year, holiday/event banners. */
function AppleCalendar() {
  const events = useAppStore((s) => s.calendarEvents);
  const addEvent = useAppStore((s) => s.addCalendarEvent);
  const removeEvent = useAppStore((s) => s.removeCalendarEvent);
  const openDaily = useAppStore((s) => s.openDailyNote);
  const setOverlayOpen = useAppStore((s) => s.setOverlayOpen);
  const notes = useAppStore((s) => s.notes);
  const contentCache = useAppStore((s) => s.contentCache);
  const tasksFile = useAppStore((s) => s.settings.tasksFile);

  const today = localISO();
  const [view, setView] = useState<CalView>("month");
  const [cursor, setCursor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [evTitle, setEvTitle] = useState("");
  const [cy, cm] = dateParts(cursor);

  const holidays = useMemo(() => holidaysForYear(cy), [cy]);
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      const l = map.get(e.date) ?? [];
      l.push(e);
      map.set(e.date, l);
    }
    return map;
  }, [events]);

  // Personal tasks due on each date, so they show as banners in the calendar.
  // "Personal" follows the same rule as the Tasks dashboard: tasks living in
  // the user's tasks note (settings.tasksFile). Agent tasks (in other notes)
  // are intentionally excluded — the calendar is for the user's own to-dos.
  const personalTasksByDate = useMemo(() => {
    const map = new Map<string, TaskItem[]>();
    const rel = (tasksFile || "Tasks.md").trim();
    const meta = notes[rel];
    const content = contentCache[rel];
    if (meta && content != null) {
      for (const t of parseTasks(rel, meta.title, content)) {
        if (t.checked || !t.due) continue;
        const l = map.get(t.due) ?? [];
        l.push(t);
        map.set(t.due, l);
      }
    }
    return map;
  }, [notes, contentCache, tasksFile]);

  type Banner = { title: string; holiday: boolean; task?: boolean };
  const banners = (date: string): Banner[] => {
    const out: Banner[] = [];
    if (holidays[date]) out.push({ title: holidays[date], holiday: true });
    for (const e of eventsByDate.get(date) ?? [])
      out.push({ title: e.title, holiday: false });
    for (const t of personalTasksByDate.get(date) ?? [])
      out.push({ title: t.text, holiday: false, task: true });
    return out;
  };

  const prev = () =>
    setCursor((c) =>
      view === "day" ? shiftISO(c, -1) : view === "week" ? shiftISO(c, -7) : view === "month" ? shiftISO(c, 0, -1) : shiftISO(c, 0, 0, -1)
    );
  const next = () =>
    setCursor((c) =>
      view === "day" ? shiftISO(c, 1) : view === "week" ? shiftISO(c, 7) : view === "month" ? shiftISO(c, 0, 1) : shiftISO(c, 0, 0, 1)
    );
  const goToday = () => {
    setCursor(today);
    setSelected(today);
  };
  const submitEvent = () => {
    const t = evTitle.trim();
    if (!t) return;
    setEvTitle("");
    void addEvent(selected, t);
  };

  const heading =
    view === "year"
      ? String(cy)
      : view === "month"
      ? `${MONTH_NAMES[cm - 1]} ${cy}`
      : view === "week"
      ? `${weekMatrix(cursor, 0)[0].slice(5)} – ${weekMatrix(cursor, 0)[6].slice(5)}`
      : new Date(cy, cm - 1, dateParts(cursor)[2]).toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        });

  const monthGrid = (year: number, month0: number, mini = false) => {
    const weeks = monthMatrix(year, month0, 0); // Sunday-first (Apple)
    return (
      <div className={"cal2-grid" + (mini ? " mini" : "")}>
        {!mini &&
          SUN_DOW.map((d) => (
            <div key={d} className="cal2-dow">
              {d}
            </div>
          ))}
        {weeks.flat().map((date) => {
          const inMonth = Number(date.slice(5, 7)) - 1 === month0;
          const bs = banners(date);
          return (
            <div
              key={date}
              className={
                "cal2-cell" +
                (inMonth ? "" : " out") +
                (date === selected ? " sel" : "")
              }
              title={date}
              onClick={() => {
                setSelected(date);
                if (mini) {
                  setCursor(date);
                  setView("month");
                }
              }}
            >
              <span className={"cal2-num" + (date === today ? " today" : "")}>
                {Number(date.slice(8, 10))}
              </span>
              {!mini &&
                bs.slice(0, 3).map((b, i) => (
                  <span key={i} className={"cal2-ban" + (b.holiday ? " holiday" : "") + (b.task ? " task" : "")}>
                    {b.holiday && <span className="cal2-star">★</span>}
                    {b.task && "☐ "}
                    {b.title}
                  </span>
                ))}
              {!mini && bs.length > 3 && (
                <span className="cal2-more">+{bs.length - 3} more</span>
              )}
              {mini && bs.length > 0 && <span className="cal2-dot" />}
            </div>
          );
        })}
      </div>
    );
  };

  const selBanners = banners(selected);

  return (
    <div className={"cal2 view-" + view}>
      <div className="cal2-bar">
        <div className="cal2-title">
          <b>{view === "year" ? "" : MONTH_NAMES[cm - 1]}</b>{" "}
          {view === "year" ? cy : view === "month" ? cy : heading}
        </div>
        <div className="seg cal2-views">
          {(["day", "week", "month", "year"] as CalView[]).map((v) => (
            <button
              key={v}
              className={"seg-btn" + (view === v ? " on" : "")}
              onClick={() => setView(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="cal2-nav">
          <button className="icon-btn" onClick={prev} aria-label="Previous">
            ‹
          </button>
          <button className="btn" onClick={goToday}>
            Today
          </button>
          <button className="icon-btn" onClick={next} aria-label="Next">
            ›
          </button>
        </div>
      </div>

      <div className="cal2-body">
        {view === "month" && monthGrid(cy, cm - 1)}

        {view === "year" && (
          <div className="cal2-year">
            {Array.from({ length: 12 }, (_, mo) => (
              <div key={mo} className="cal2-year-cell">
                <button
                  className="cal2-year-name"
                  onClick={() => {
                    setCursor(`${cy}-${String(mo + 1).padStart(2, "0")}-01`);
                    setView("month");
                  }}
                >
                  {MONTH_NAMES[mo]}
                </button>
                {monthGrid(cy, mo, true)}
              </div>
            ))}
          </div>
        )}

        {view === "week" && (
          <div className="cal2-week">
            {weekMatrix(cursor, 0).map((date, i) => (
              <div
                key={date}
                className={
                  "cal2-week-col" + (date === selected ? " sel" : "")
                }
                onClick={() => setSelected(date)}
              >
                <div className="cal2-week-head">
                  <span>{SUN_DOW[i]}</span>
                  <span className={"cal2-num" + (date === today ? " today" : "")}>
                    {Number(date.slice(8, 10))}
                  </span>
                </div>
                {banners(date).map((b, j) => (
                  <span key={j} className={"cal2-ban" + (b.holiday ? " holiday" : "") + (b.task ? " task" : "")}>
                    {b.holiday && <span className="cal2-star">★</span>}
                    {b.task && "☐ "}
                    {b.title}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}

        {view === "day" && (
          <div className="cal2-day">
            <div className="cal2-day-head">
              {new Date(cy, cm - 1, dateParts(cursor)[2]).toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </div>
            {banners(cursor).length === 0 ? (
              <div className="palette-empty">Nothing scheduled.</div>
            ) : (
              banners(cursor).map((b, i) => (
                <div
                  key={i}
                  className={"cal2-ban big" + (b.holiday ? " holiday" : "") + (b.task ? " task" : "")}
                >
                  {b.holiday && <span className="cal2-star">★</span>}
                  {b.task && "☐ "}
                  {b.title}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="cal2-foot">
        <div className="cal2-foot-day">
          {selected}
          <button
            className="btn ghost"
            onClick={() => {
              void openDaily(selected);
              setOverlayOpen(false);
            }}
          >
            Open note
          </button>
        </div>
        <div className="cal2-add">
          <input
            className="text-input"
            placeholder={`Add event on ${selected}…`}
            value={evTitle}
            onChange={(e) => setEvTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitEvent();
            }}
          />
          <button className="btn" onClick={submitEvent} disabled={!evTitle.trim()}>
            +
          </button>
        </div>
        {selBanners.length > 0 && (
          <div className="cal2-foot-list">
            {selBanners.map((b, i) => (
              <div key={i} className="cal2-foot-ev">
                <span className={b.holiday ? "holiday" : ""}>
                  {b.holiday ? "★ " : b.task ? "☐ " : ""}
                  {b.title}
                </span>
                {/* Events can be removed inline; tasks are managed in the Tasks
                    window (they live in the tasks note, not calendar.json). */}
                {!b.holiday && !b.task && (
                  <button
                    className="cal-event-del"
                    onClick={() => void removeEvent(selected, b.title)}
                    title="Remove"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Per-day scratchpad with a date picker. */
function Scratchpad() {
  const [day, setDay] = useState(localISO());
  const [text, setText] = useState(() => lsGet(SCRATCH_PREFIX + localISO()));
  useEffect(() => {
    setText(lsGet(SCRATCH_PREFIX + day));
  }, [day]);
  const save = (v: string) => {
    setText(v);
    lsSet(SCRATCH_PREFIX + day, v);
  };
  return (
    <div className="ov-scratch-win">
      <input
        type="date"
        className="text-input"
        value={day}
        onChange={(e) => setDay(e.target.value || localISO())}
      />
      <textarea
        className="ov-scratch"
        placeholder="A quick note for this day… (saved automatically)"
        value={text}
        onChange={(e) => save(e.target.value)}
      />
    </div>
  );
}

/** A persistent whiteboard. */
function Whiteboard() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [color, setColor] = useState("#e0a948");
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement!;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const saved = lsGet(WHITEBOARD_KEY);
    if (saved) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = saved;
    }
  }, []);
  const at = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = at(e);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    lsSet(WHITEBOARD_KEY, canvasRef.current!.toDataURL());
  };
  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    lsSet(WHITEBOARD_KEY, "");
  };
  const COLORS = ["#e0a948", "#7259cc", "#3cae8b", "#ff6b6b", "#cfd6e6"];
  return (
    <div className="ov-board">
      <div className="ov-board-bar">
        {COLORS.map((c) => (
          <button
            key={c}
            className={"ov-swatch" + (color === c ? " on" : "")}
            style={{ background: c }}
            onClick={() => setColor(c)}
            aria-label={"Pen " + c}
          />
        ))}
        <button className="btn ghost" onClick={clear}>
          Clear
        </button>
      </div>
      <div className="ov-board-canvas">
        <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} />
      </div>
    </div>
  );
}

/** Gallery of the vault's images. */
function Gallery() {
  const files = useAppStore((s) => s.files);
  const selectFile = useAppStore((s) => s.selectFile);
  const setOverlayOpen = useAppStore((s) => s.setOverlayOpen);
  const images = useMemo(
    () => files.filter((f) => isImageExt(f.ext) || f.ext === "svg"),
    [files]
  );
  if (images.length === 0)
    return <div className="palette-empty ov-empty">No images in this vault yet.</div>;
  return (
    <div className="ov-gallery">
      {images.map((f) => (
        <button
          key={f.relPath}
          className="ov-gallery-cell"
          title={f.relPath}
          onClick={() => {
            void selectFile(f.relPath);
            setOverlayOpen(false);
          }}
        >
          <img src={urlForPath(f.path)} alt={f.name} loading="lazy" />
          <span className="ov-gallery-name">{f.name}</span>
        </button>
      ))}
    </div>
  );
}

function OverlayToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function OverlaySettings({ onReset }: { onReset: () => void }) {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);

  return (
    <div className="ov-settings">
      <section className="ov-settings-section">
        <div className="setting-name">Theme</div>
        <div className="seg theme-seg">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={"seg-btn" + (t.id === theme ? " on" : "")}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
      <section className="ov-settings-section">
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Tabs</div>
            <div className="setting-desc">Optional browser-style editor tabs.</div>
          </div>
          <OverlayToggle
            on={settings.enableTabs}
            onChange={(v) => setSetting("enableTabs", v)}
          />
        </div>
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Auto-hide sidebar</div>
            <div className="setting-desc">Reveal the sidebar from the left edge.</div>
          </div>
          <OverlayToggle
            on={settings.sidebarAutoHide}
            onChange={(v) => {
              setSetting("sidebarAutoHide", v);
              if (v) setSetting("sidebarOpen", true);
            }}
          />
        </div>
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Animations</div>
            <div className="setting-desc">Window motion, fades, and UI transitions.</div>
          </div>
          <OverlayToggle
            on={settings.animations}
            onChange={(v) => setSetting("animations", v)}
          />
        </div>
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Hardware acceleration</div>
            <div className="setting-desc">GPU-assisted graph canvas when available.</div>
          </div>
          <OverlayToggle
            on={settings.hardwareAccel}
            onChange={(v) => setSetting("hardwareAccel", v)}
          />
        </div>
      </section>
      <section className="ov-settings-section">
        <div className="setting-name">Overlay windows</div>
        <div className="setting-desc">
          Re-fit the overlay window layout if a pane is off-screen or awkwardly sized.
        </div>
        <button className="btn" onClick={onReset}>
          Reset overlay layout
        </button>
      </section>
    </div>
  );
}

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

function OverlayTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const current = OVERLAY_TOUR_STEPS[step];
  const last = step === OVERLAY_TOUR_STEPS.length - 1;
  return (
    <div className="ov-tour">
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

function OverlayHelp({
  onClose,
  onTour,
}: {
  onClose: () => void;
  onTour: () => void;
}) {
  return (
    <div className="ov-help-layer" role="dialog" aria-modal="true" aria-label="Mesa guide">
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
            <h3>Steam overlay</h3>
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

/** Steam-style overlay: dim backdrop, bottom dock, floating windows. */
export function Overlay() {
  const open = useAppStore((s) => s.overlayOpen);
  const animations = useAppStore((s) => s.settings.animations);
  const setOpen = useAppStore((s) => s.setOverlayOpen);
  const toggleOverlay = useAppStore((s) => s.toggleOverlay);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);
  const deepResearchOpenToken = useAppStore((s) => s.deepResearchOpenToken);
  const openDeepResearch = useAppStore((s) => s.openDeepResearch);
  const [wins, setWins] = useState<Wins>(() => loadWins());
  const [order, setOrder] = useState<WinId[]>([
    "scratch",
    "whiteboard",
    "gallery",
    "settings",
    "search",
    "agent",
    "tasks",
    "calendar",
  ]);
  const [renderOverlay, setRenderOverlay] = useState(open);
  const [, setViewportTick] = useState(0);
  const [visible, setVisible] = useState(open);
  const [showTour, setShowTour] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

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
  // Store-level callers can bump deepResearchOpenToken to open + focus the
  // Steam-overlay research window. Pi's launcher owns a separate slide-out
  // wing and deliberately initializes the shared run without bumping it.
  useEffect(() => {
    if (!deepResearchOpenToken) return;
    setOpen(true);
    setWins((w) => ({ ...w, research: { ...w.research, open: true } }));
    setOrder((o) => [...o.filter((x) => x !== "research"), "research"]);
  }, [deepResearchOpenToken, setOpen]);
  useEffect(() => {
    if (wins.research.open) openDeepResearch(false);
  }, [wins.research.open, openDeepResearch]);
  useEffect(() => {
    if (!open) return;
    // Re-render on viewport changes so the render-time fitToViewport
    // projection tracks the new size; the stored geometry is left alone.
    const onResize = () => setViewportTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
      // Shift+Tab is the symmetric toggle. Use the debounced store toggle so
      // the app-shell listener and this one can't double-fire on a single
      // press and snap the overlay shut (the "immediately closes" bug).
      if (isPlainShiftTab(e) && !e.repeat) {
        const el = document.activeElement as HTMLElement | null;
        if (!isTextEntryTarget(el)) {
          claimKeyboardShortcut(e);
          toggleOverlay();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, toggleOverlay]);

  if (!renderOverlay) return null;

  const focus = (id: WinId) => setOrder((o) => [...o.filter((x) => x !== id), id]);
  const patch = (id: WinId, p: Partial<WinRec>) =>
    setWins((w) => ({ ...w, [id]: { ...w[id], ...p } }));
  const toggle = (id: WinId) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], open: !w[id].open } }));
    focus(id);
  };
  const openWindow = (id: WinId) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], open: true } }));
    focus(id);
  };
  const resetOverlayLayout = () => {
    setWins(mergeStoredWins(DEFAULT_WINS, {}));
    setOrder(["scratch", "whiteboard", "gallery", "settings", "search", "agent", "tasks", "calendar"]);
  };
  const content = (id: WinId) =>
    id === "calendar" ? (
      <AppleCalendar />
    ) : id === "search" ? (
      <SearchSurface
        onClose={() => setOpen(false)}
        onAgent={() => openWindow("agent")}
      />
    ) : id === "research" ? (
      <DeepResearchPanel />
    ) : id === "tasks" ? (
      <TasksPanel onPick={() => setOpen(false)} />
    ) : id === "scratch" ? (
      <Scratchpad />
    ) : id === "whiteboard" ? (
      <Whiteboard />
    ) : id === "settings" ? (
      <OverlaySettings onReset={resetOverlayLayout} />
    ) : (
      <Gallery />
    );

  return (
    <div className={"overlay" + (visible ? " visible" : "")}>
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
        !wins[id].open ? null : id === "agent" ? (
          <PiOverlayWindow
            key={id}
            rec={fitToViewport(wins[id])}
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
            rec={fitToViewport(wins[id])}
            z={10 + order.indexOf(id)}
            onChange={(p) => patch(id, p)}
            onClose={() => toggle(id)}
            onFocus={() => focus(id)}
          >
            {content(id)}
          </FloatingWindow>
        )
      )}

      <div className="ov-dock">
        {DOCK.map((d) => (
          <button
            key={d.id}
            className={"ov-dock-btn" + (wins[d.id].open ? " on" : "")}
            onClick={() => {
              if (d.id === "research") openDeepResearch(false);
              toggle(d.id);
            }}
            title={d.label}
          >
            <span className="ov-dock-icon">{d.icon}</span>
            <span className="ov-dock-label">{d.label}</span>
          </button>
        ))}
      </div>

      <button
        className="ov-help-button"
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
