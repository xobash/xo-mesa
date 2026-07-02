import { useMemo } from "react";
import { useAppStore } from "../store";
import { previewEnter, previewLeave } from "./previewTriggers";
import { hueFor } from "../lib/hue";

export function TagList() {
  const notes = useAppStore((s) => s.notes);
  const setSearchSeed = useAppStore((s) => s.setSearchSeed);
  const setSearch = useAppStore((s) => s.setSearch);
  const collapsed = useAppStore((s) => s.settings.tagsCollapsed);
  const setSetting = useAppStore((s) => s.setSetting);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of Object.keys(notes)) {
      for (const t of notes[id].tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);

  if (counts.length === 0) return null;

  return (
    <div className={"tag-section" + (collapsed ? " collapsed" : "")}>
      <button
        className="sidebar-header tag-header"
        onClick={() => setSetting("tagsCollapsed", !collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? "Show tags" : "Hide tags"}
      >
        <span className={"tag-caret" + (collapsed ? " collapsed" : "")}>▾</span>
        Tags
        <span className="tag-section-count">{counts.length}</span>
      </button>
      {!collapsed && (
      <div className="tag-list">
        {counts.map(([t, c]) => {
          const h = hueFor(t);
          return (
            <button
              key={t}
              className="tag-chip"
              style={{
                background: `hsl(${h} 45% 50% / 0.08)`,
                borderColor: `hsl(${h} 40% 55% / 0.28)`,
              }}
              onClick={() => {
                previewLeave();
                setSearchSeed("#" + t);
                setSearch(true);
              }}
              onMouseEnter={(e) =>
                previewEnter(
                  { kind: "tag", tag: t },
                  e.currentTarget.getBoundingClientRect()
                )
              }
              onMouseLeave={previewLeave}
            >
              <span className="tag-hash" style={{ color: `hsl(${h} 45% 60%)` }}>
                #
              </span>
              {t}
              <span className="tag-count">{c}</span>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}
