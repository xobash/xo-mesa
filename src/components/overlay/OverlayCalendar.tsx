import { useMemo, useState } from "react";
import { useAppStore } from "../../store";
import {
  localISO,
  shiftISO,
  monthMatrix,
  calendarGridKeyTarget,
  weekMatrix,
  MONTH_NAMES,
  holidaysForYear,
  type CalEvent,
} from "../../lib/daily";
import { collectVaultTasks, type TaskItem } from "../../lib/tasks";

const SUN_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CalView = "day" | "week" | "month" | "year";

function dateParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

/** Overlay calendar: day/week/month/year views with holiday, event and due-task banners. */
export function OverlayCalendar() {
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
  // The dashboard and calendar share marker-based ownership. The configured
  // tasks file is only where new personal tasks are created.
  const personalTasksByDate = useMemo(() => {
    const map = new Map<string, TaskItem[]>();
    for (const t of collectVaultTasks(notes, contentCache, (tasksFile || "Tasks.md").trim())) {
      if (t.kind !== "personal" || t.checked || !t.due) continue;
      const l = map.get(t.due) ?? [];
      l.push(t);
      map.set(t.due, l);
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
    const weeks = monthMatrix(year, month0, 0); // Sunday-first
    const selectGridDate = (
      date: string,
      origin?: HTMLButtonElement
    ) => {
      setSelected(date);
      setCursor(date);
      if (mini) setView("month");
      if (!origin) return;
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            `.cal2-cell[data-calendar-date="${date}"]`
          )
          ?.focus();
      });
    };
    return (
      <div
        className={"cal2-grid" + (mini ? " mini" : "")}
        role="grid"
        aria-label={`${MONTH_NAMES[month0]} ${year}`}
      >
        {!mini && <div className="cal2-row" role="row">
          {SUN_DOW.map((d) => (
            <div key={d} className="cal2-dow" role="columnheader">
              {d}
            </div>
          ))}
        </div>}
        {weeks.map((week) => <div key={week[0]} className="cal2-row" role="row">
        {week.map((date) => {
          const inMonth = Number(date.slice(5, 7)) - 1 === month0;
          const bs = banners(date);
          const [dateYear, dateMonth, dateDay] = dateParts(date);
          const dateLabel = new Date(
            dateYear,
            dateMonth - 1,
            dateDay
          ).toLocaleDateString(undefined, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          return (
            <button
              type="button"
              role="gridcell"
              key={date}
              className={
                "cal2-cell" +
                (inMonth ? "" : " out") +
                (date === selected ? " sel" : "")
              }
              title={date}
              data-calendar-date={date}
              aria-selected={date === selected}
              aria-current={date === today ? "date" : undefined}
              aria-label={
                dateLabel +
                (bs.length
                  ? `: ${bs.map((banner) => banner.title).join(", ")}`
                  : "")
              }
              tabIndex={date === selected ? 0 : -1}
              onClick={() => selectGridDate(date)}
              onKeyDown={(event) => {
                const target = calendarGridKeyTarget(date, event.key);
                if (!target) return;
                event.preventDefault();
                selectGridDate(target, event.currentTarget);
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
            </button>
          );
        })}
        </div>)}
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
              aria-pressed={view === v}
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
          <button className="btn" onClick={submitEvent} disabled={!evTitle.trim()} aria-label={`Add event on ${selected}`} title="Add event">
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
