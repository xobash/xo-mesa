import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, getStore } from "../store";
import { templatePaths } from "../lib/daily";
import { formatHotkey } from "../lib/hotkeys";
import { activeEditorCommands } from "../lib/editorCommands";
import { PALETTE_COMMANDS } from "./paletteCommands";
import { Modal } from "./Modal";
import { fuzzy } from "../lib/fuzzy";

/** Fill a template for the open note and insert it at the editor selection. */
async function insertTemplate(relPath: string) {
  const text = await getStore().renderTemplate(relPath);
  if (text === null) return;
  if (!activeEditorCommands()?.insertText(text)) {
    useAppStore.setState({ status: "Open an editable note to insert a template." });
  }
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const mode = useAppStore((s) => s.paletteMode);
  const setPalette = useAppStore((s) => s.setPalette);
  const files = useAppStore((s) => s.files);
  const templatesFolder = useAppStore((s) => s.settings.templatesFolder);
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
  }, [open, mode]);

  const isTemplates = mode === "templates";
  const isCmd = !isTemplates && q.startsWith(">");

  const commands = PALETTE_COMMANDS;
  const hotkeys = useAppStore((s) => s.settings.hotkeys);

  const templateResults = useMemo(() => {
    if (!isTemplates) return [];
    return templatePaths(files, templatesFolder)
      .map((relPath) => ({ relPath, score: fuzzy(q, relPath) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.relPath);
  }, [isTemplates, q, files, templatesFolder]);

  const fileResults = useMemo(() => {
    if (isTemplates) return [];
    return files
      .filter((f) => f.isMarkdown)
      .map((f) => ({ f, score: fuzzy(q, f.name) + 0.4 * fuzzy(q, f.relPath) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.f);
  }, [isTemplates, q, files]);

  const cmdResults = useMemo(() => {
    const qq = q.slice(1).trim();
    return commands
      .map((c) => ({ c, score: qq ? fuzzy(qq, c.label) : 1 }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [q, commands]);

  const count = isTemplates ? templateResults.length : isCmd ? cmdResults.length : fileResults.length;

  function exec(i: number) {
    if (isTemplates) {
      const relPath = templateResults[i];
      if (relPath) {
        setPalette(false);
        void insertTemplate(relPath);
      }
    } else if (isCmd) {
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
    <Modal onClose={() => setPalette(false)} align="top" className="palette" title="Command palette">
      <input
        ref={inputRef}
        className="palette-input"
        placeholder={isTemplates ? "Insert template…" : "Search notes…  (type > for commands)"}
        aria-label={isTemplates ? "Search templates" : "Search notes and commands"}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={onKey}
      />
      <div className="palette-list" ref={listRef}>
        {isTemplates
          ? templateResults.map((relPath, i) => (
              <button
                key={relPath}
                className={"palette-item" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(i)}
              >
                <span className="palette-name">{relPath.split("/").pop()!.replace(/\.(md|markdown)$/i, "")}</span>
                <span className="palette-hint">{relPath}</span>
              </button>
            ))
          : isCmd
          ? cmdResults.map((c, i) => (
              <button
                key={c.id}
                className={"palette-item" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(i)}
              >
                <span>{c.label}</span>
                {(hotkeys?.[c.id] || c.hint) && (
                  <span className="palette-hint">{formatHotkey(hotkeys?.[c.id] || c.hint || "")}</span>
                )}
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
        {count === 0 && (
          <div className="palette-empty">
            {isTemplates && !templatePaths(files, templatesFolder).length
              ? `No templates found. Add Markdown notes to the “${templatesFolder.trim() || "Templates"}” folder (set it in Settings).`
              : "No matches"}
          </div>
        )}
      </div>
    </Modal>
  );
}
