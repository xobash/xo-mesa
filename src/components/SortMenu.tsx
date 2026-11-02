import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import { SORT_LABELS } from "../lib/sort";
import type { SortMode } from "../types";

/** Sidebar sort and file-type filter popover. */
export function SortMenu() {
  const sortMode = useAppStore((s) => s.settings.sortMode);
  const sortDir = useAppStore((s) => s.settings.sortDir);
  const typeFilter = useAppStore((s) => s.settings.typeFilter);
  const files = useAppStore((s) => s.files);
  const setSetting = useAppStore((s) => s.setSetting);
  const [open, setOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const presentTypes = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) set.add(f.ext.toLowerCase());
    return [...set].sort();
  }, [files]);

  const modes: SortMode[] = ["name", "modified", "size", "links", "type"];
  const active = typeFilter !== "all";
  return (
    <div className="sort-menu" ref={ref}>
      <button
        className={"sort-btn" + (active ? " on" : "")}
        onClick={() => setOpen((v) => !v)}
        title={"Sort: " + SORT_LABELS[sortMode]}
      >
        ⇅
      </button>
      {open && (
        <div className="theme-pop sort-pop">
          <div className="sort-pop-label">Sort by</div>
          {modes.map((m) => (
            <button
              key={m}
              className={"theme-opt" + (m === sortMode ? " on" : "")}
              onClick={() => setSetting("sortMode", m)}
            >
              {SORT_LABELS[m]}
            </button>
          ))}
          <div className="sort-pop-row">
            <button
              className={"seg-btn" + (sortDir === "asc" ? " on" : "")}
              onClick={() => setSetting("sortDir", "asc")}
              title="Ascending / natural order"
            >
              ↑ Asc
            </button>
            <button
              className={"seg-btn" + (sortDir === "desc" ? " on" : "")}
              onClick={() => setSetting("sortDir", "desc")}
              title="Descending / reversed"
            >
              ↓ Desc
            </button>
          </div>
          <button
            className="theme-opt sort-accordion"
            onClick={() => setTypeOpen((v) => !v)}
            aria-expanded={typeOpen}
          >
            <span className={"tag-caret" + (typeOpen ? "" : " collapsed")}>▾</span>
            File type
            <span className="sort-type-current">
              {typeFilter === "all" ? "All" : "." + typeFilter}
            </span>
          </button>
          {typeOpen && (
            <div className="sort-type-list">
              <button
                className={"theme-opt" + (typeFilter === "all" ? " on" : "")}
                onClick={() => setSetting("typeFilter", "all")}
              >
                All types
              </button>
              {presentTypes.map((t) => (
                <button
                  key={t}
                  className={"theme-opt" + (typeFilter === t ? " on" : "")}
                  onClick={() => setSetting("typeFilter", t)}
                >
                  .{t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
