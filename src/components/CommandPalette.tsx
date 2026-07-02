import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, getStore, THEMES } from "../store";
import { localISO } from "../lib/daily";
import { Modal } from "./Modal";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Subsequence fuzzy score (higher = better, 0 = no match). */
function fuzzy(q: string, text: string): number {
  if (!q) return 0.5;
  const t = text.toLowerCase();
  q = q.toLowerCase();
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return 0;
  if (t.startsWith(q)) score += 6;
  return score / (1 + t.length * 0.04);
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setPalette = useAppStore((s) => s.setPalette);
  const files = useAppStore((s) => s.files);
  const selectFile = useAppStore((s) => s.selectFile);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const isCmd = q.startsWith(">");

  const commands: Cmd[] = useMemo(
    () => [
      { id: "new", label: "New note", hint: "⌘N", run: () => void getStore().newNote() },
      { id: "search", label: "Search in all notes", hint: "⌘⇧F", run: () => getStore().setSearch(true) },
      { id: "tasks", label: "Open tasks dashboard", run: () => getStore().setTasksOpen(true) },
      {
        id: "calendar",
        label: "Open calendar (overlay)",
        hint: "⇧Tab",
        run: () => getStore().setOverlayOpen(true),
      },
      {
        id: "today",
        label: "Open today's daily note",
        run: () => void getStore().openDailyNote(localISO()),
      },
      { id: "help", label: "Help & guide", run: () => getStore().setHelpOpen(true) },
      { id: "settings", label: "Open settings", hint: "⌘,", run: () => getStore().setSettingsOpen(true) },
      { id: "graph", label: "Toggle full graph", run: () => getStore().toggleGraphFull() },
      {
        id: "theme",
        label: "Cycle theme",
        run: () => {
          const s = getStore();
          const order = THEMES.map((t) => t.id);
          s.setTheme(order[(order.indexOf(s.theme) + 1) % order.length]);
        },
      },
      { id: "vault", label: "Open vault…", run: () => void getStore().openVault() },
    ],
    []
  );

  const fileResults = useMemo(() => {
    return files
      .filter((f) => f.isMarkdown)
      .map((f) => ({ f, score: fuzzy(q, f.name) + 0.4 * fuzzy(q, f.relPath) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.f);
  }, [q, files]);

  const cmdResults = useMemo(() => {
    const qq = q.slice(1).trim();
    return commands
      .map((c) => ({ c, score: qq ? fuzzy(qq, c.label) : 1 }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [q, commands]);

  const count = isCmd ? cmdResults.length : fileResults.length;

  function exec(i: number) {
    if (isCmd) {
      const c = cmdResults[i];
      if (c) {
        setPalette(false);
        c.run();
      }
    } else {
      const f = fileResults[i];
      if (f) {
        setPalette(false);
        void selectFile(f.relPath);
      }
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(count - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(sel);
    }
  }

  useEffect(() => {
    const el = listRef.current?.querySelector(".palette-item.sel");
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  return (
    <Modal onClose={() => setPalette(false)} align="top" className="palette">
      <input
        ref={inputRef}
        className="palette-input"
        placeholder="Search notes…  (type > for commands)"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={onKey}
      />
      <div className="palette-list" ref={listRef}>
        {isCmd
          ? cmdResults.map((c, i) => (
              <button
                key={c.id}
                className={"palette-item" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(i)}
              >
                <span>{c.label}</span>
                {c.hint && <span className="palette-hint">{c.hint}</span>}
              </button>
            ))
          : fileResults.map((f, i) => (
              <button
                key={f.relPath}
                className={"palette-item" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(i)}
              >
                <span className="palette-name">{f.name}</span>
                <span className="palette-hint">{f.relPath}</span>
              </button>
            ))}
        {count === 0 && <div className="palette-empty">No matches</div>}
      </div>
    </Modal>
  );
}
