import { useMemo, useState } from "react";
import { useAppStore } from "../store";
import { parseTasks, groupTasks, taskProject, type TaskItem } from "../lib/tasks";
import { localISO } from "../lib/daily";
import { Modal } from "./Modal";

type Filter = "all" | "personal" | "agent";
type TaskView = "list" | "board";

function offsetISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The Tasks dashboard body — used both in the modal and docked in a pane. */
export function TasksPanel({ onPick }: { onPick?: () => void }) {
  const notes = useAppStore((s) => s.notes);
  const cache = useAppStore((s) => s.contentCache);
  const selectFile = useAppStore((s) => s.selectFile);
  const tasksFile = useAppStore((s) => s.settings.tasksFile);
  const addPersonalTask = useAppStore((s) => s.addPersonalTask);
  const updateTask = useAppStore((s) => s.updateTask);
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<TaskView>("list");
  const [draft, setDraft] = useState("");
  const today = localISO();
  const next = offsetISO(1);

  const all = useMemo(() => {
    const personalRel = (tasksFile || "Tasks.md").trim();
    const out: TaskItem[] = [];
    for (const rel of Object.keys(notes)) {
      const c = cache[rel];
      if (c == null) continue;
      // Personal = the tasks the user added themselves (live in the tasks note);
      // everything else parsed from the vault is agent work.
      const kind = rel === personalRel ? "personal" : "agent";
      for (const t of parseTasks(rel, notes[rel].title, c)) {
        out.push({ ...t, kind });
      }
    }
    return out;
  }, [notes, cache, tasksFile]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setFilter("personal");
    void addPersonalTask(text);
  };

  const counts = useMemo(() => {
    let agent = 0;
    let personal = 0;
    for (const t of all) {
      if (t.checked) continue;
      if (t.kind === "agent") agent++;
      else personal++;
    }
    return { agent, personal };
  }, [all]);

  const groups = useMemo(() => {
    const filtered =
      filter === "all" ? all : all.filter((t) => t.kind === filter);
    return groupTasks(filtered, today);
  }, [all, filter, today]);

  const openTotal =
    groups.overdue.length +
    groups.today.length +
    groups.upcoming.length +
    groups.noDue.length;

  const section = (label: string, items: TaskItem[], cls = "") =>
    items.length > 0 && (
      <div className="task-group">
        <div className={"task-group-title " + cls}>
          {label}
          <span className="count">{items.length}</span>
        </div>
        {items.map((t, i) => (
          <button
            key={t.rel + ":" + t.line + ":" + i}
            className="task-row"
            onClick={() => {
              onPick?.();
              void selectFile(t.rel);
            }}
          >
            <span className={"task-box" + (t.checked ? " done" : "")} />
            <span className={"task-text" + (t.checked ? " done" : "")}>
              {t.text}
            </span>
            {t.kind === "agent" && <span className="task-kind">AI</span>}
            {t.due && <span className="task-due">{t.due}</span>}
            <span className="task-note" title={t.rel}>
              {taskProject(t.rel) && (
                <span className="task-project">{taskProject(t.rel)}/</span>
              )}
              {t.noteTitle}
            </span>
          </button>
        ))}
      </div>
    );

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "personal", label: `Personal (${counts.personal})` },
    { id: "agent", label: `Agent (${counts.agent})` },
  ];

  const card = (t: TaskItem) => (
    <div className={"kanban-card" + (t.checked ? " done" : "")} key={t.rel + ":" + t.line}>
      <button
        className="kanban-card-main"
        onClick={() => {
          onPick?.();
          void selectFile(t.rel);
        }}
      >
        <span className="kanban-card-text">{t.text}</span>
        <span className="kanban-card-source" title={t.rel}>
          {taskProject(t.rel) && `${taskProject(t.rel)}/`}
          {t.noteTitle}
        </span>
      </button>
      <div className="kanban-card-actions">
        <button
          className="mini-btn"
          onClick={() => void updateTask(t.rel, t.line, { checked: !t.checked })}
        >
          {t.checked ? "Reopen" : "Done"}
        </button>
        <button
          className="mini-btn"
          onClick={() => void updateTask(t.rel, t.line, { checked: false, due: today })}
        >
          Today
        </button>
        <button
          className="mini-btn"
          onClick={() => void updateTask(t.rel, t.line, { checked: false, due: next })}
        >
          Next
        </button>
        <button
          className="mini-btn"
          onClick={() => void updateTask(t.rel, t.line, { checked: false, due: null })}
        >
          No date
        </button>
      </div>
    </div>
  );

  const boardColumns: { id: string; title: string; items: TaskItem[] }[] = [
    { id: "overdue", title: "Overdue", items: groups.overdue },
    { id: "today", title: "Today", items: groups.today },
    { id: "upcoming", title: "Upcoming", items: groups.upcoming },
    { id: "backlog", title: "Backlog", items: groups.noDue },
    { id: "done", title: "Done", items: groups.done.slice(0, 80) },
  ];

  return (
    <>
      <div className="panel-toolbar">
        <span className="count">{openTotal} open</span>
        <div className="seg">
          {(["list", "board"] as TaskView[]).map((v) => (
            <button
              key={v}
              className={"seg-btn" + (view === v ? " on" : "")}
              onClick={() => setView(v)}
            >
              {v === "list" ? "List" : "Board"}
            </button>
          ))}
        </div>
        <div className="seg">
          {filters.map((f) => (
            <button
              key={f.id}
              className={"seg-btn" + (filter === f.id ? " on" : "")}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="task-add">
        <input
          className="text-input"
          placeholder="Add a personal task…  (Enter)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitDraft();
          }}
        />
        <button className="btn" onClick={submitDraft} disabled={!draft.trim()}>
          + Add
        </button>
      </div>
      <div className={"tasks-body" + (view === "board" ? " board" : "")}>
        {view === "list" ? (
          <>
            {section("Overdue", groups.overdue, "danger")}
            {section("Today", groups.today, "accent")}
            {section("Upcoming", groups.upcoming)}
            {section("No date", groups.noDue)}
            {section("Done", groups.done.slice(0, 50))}
          </>
        ) : (
          <div className="kanban-board">
            {boardColumns.map((col) => (
              <section className={"kanban-column " + col.id} key={col.id}>
                <header className="kanban-column-head">
                  <span>{col.title}</span>
                  <span className="count">{col.items.length}</span>
                </header>
                <div className="kanban-column-body">
                  {col.items.length ? (
                    col.items.map(card)
                  ) : (
                    <div className="kanban-empty">No cards</div>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
        {openTotal === 0 && groups.done.length === 0 && (
          <div className="palette-empty">
            No tasks yet — add a personal one above, or write{" "}
            <code>- [ ] something</code> (with an optional{" "}
            <code>📅 2026-07-01</code>) in any note for the Agent tab.
          </div>
        )}
      </div>
    </>
  );
}

export function TasksModal() {
  const open = useAppStore((s) => s.tasksOpen);
  const setOpen = useAppStore((s) => s.setTasksOpen);
  if (!open) return null;
  return (
    <Modal onClose={() => setOpen(false)} align="top" className="tasks">
      <header className="modal-head">
        <span>Tasks</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>
      <TasksPanel onPick={() => setOpen(false)} />
    </Modal>
  );
}
