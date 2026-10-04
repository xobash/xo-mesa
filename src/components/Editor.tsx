import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { useAppStore, getStore } from "../store";
import { MarkdownView } from "./MarkdownView";

const editableCompartment = new Compartment();

// Only structural styling lives here; all colors come from CSS variables in
// styles.css (.cm-editor rules) so the editor follows the active theme.
const editorLayout = EditorView.theme({
  "&": { height: "100%", fontSize: "15px" },
  ".cm-scroller": { overflow: "auto" },
});

interface EditorActivityChange { snippet: string; lines: { added: number; removed: number }; tasksUnchanged: boolean }

function activityFromUpdate(update: Parameters<Parameters<typeof EditorView.updateListener.of>[0]>[0]): EditorActivityChange {
  let snippet = "";
  let added = 0;
  let removed = 0;
  let tasksUnchanged = true;
  update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const newText = inserted.toString();
    const oldText = update.startState.doc.sliceString(fromA, toA);
    if (snippet.length < 160) snippet += newText.slice(0, 160 - snippet.length);
    added += newText.split("\n").length;
    removed += oldText.split("\n").length;
    if (newText.includes("\n") || oldText.includes("\n")) tasksUnchanged = false;
    const oldLine = update.startState.doc.lineAt(fromA).text;
    const newLine = update.state.doc.lineAt(fromB).text;
    if (toA > update.startState.doc.lineAt(fromA).to || toB > update.state.doc.lineAt(fromB).to ||
        /\[[ xX]\]|```|~~~/.test(oldLine) || /\[[ xX]\]|```|~~~/.test(newLine)) tasksUnchanged = false;
  });
  return { snippet: snippet.trim(), lines: { added, removed }, tasksUnchanged };
}

function makeState(doc: string, onUserEdit: (text: string, activity: EditorActivityChange) => void, editable = true): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      markdown(),
      editorLayout,
      EditorView.lineWrapping,
      editableCompartment.of(EditorView.editable.of(editable)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        onUserEdit(u.state.doc.toString(), activityFromUpdate(u));
      }),
    ],
  });
}

export function Editor() {
  const activePath = useAppStore((s) => s.activePath);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const content = useAppStore((s) => s.content);
  const activeContentState = useAppStore((s) => s.activeContentState);
  const loadActiveContent = useAppStore((s) => s.loadActiveContent);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The exact string we last pushed into the store from a user edit. When the
  // store echoes it back through the `content` subscription, we can skip the
  // doc-swap effect entirely — before this, EVERY keystroke serialized the
  // whole document a second time (view.state.doc.toString()) just to discover
  // nothing changed, which made typing in large notes feel sluggish.
  const lastEditorTextRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"source" | "live">("source");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [headings, setHeadings] = useState<Array<{ level: number; label: string; line: number }>>([]);
  useEffect(() => {
    if (!outlineOpen || activeContentState !== "ready") { setHeadings([]); return; }
    // The full outline is optional work. Run after the input event and coalesce
    // rapid edits instead of scanning the whole document in the render path.
    const timer = setTimeout(() => setHeadings(content.split("\n").flatMap((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      return match ? [{ level: match[1].length, label: match[2], line: index + 1 }] : [];
    })), 80);
    return () => clearTimeout(timer);
  }, [content, outlineOpen, activeContentState]);

  const goToHeading = (line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const position = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
    view.focus();
  };

  // The store owns text and unsaved revisions. Sessions retain only reusable
  // editing state; they must never override the current store snapshot.
  type CachedSession = { state: EditorState; scrollTop: number };
  const sessionsRef = useRef(new Map<string, CachedSession>());
  const docKeyRef = useRef("");
  const key = `${vaultPath ?? ""}\0${activePath ?? ""}`;
  const rememberSession = (sessionKey: string, state: EditorState, scrollTop: number) => {
    const sessions = sessionsRef.current;
    sessions.delete(sessionKey);
    sessions.set(sessionKey, { state, scrollTop });
    let chars = [...sessions.values()].reduce((sum, item) => sum + item.state.doc.length, 0);
    while (sessions.size > 8 || chars > 8 * 1024 * 1024) {
      const oldest = sessions.keys().next().value!;
      chars -= sessions.get(oldest)!.state.doc.length;
      sessions.delete(oldest);
    }
  };
  const onUserEditRef = useRef((text: string, activity: EditorActivityChange) => {
    const store = getStore();
    // A view from the preceding React commit cannot edit the newly selected file.
    if (docKeyRef.current !== `${store.vaultPath ?? ""}\0${store.activePath ?? ""}`) return;
    lastEditorTextRef.current = text;
    store.setContentFromEditor(text, activity);
  });

  // Tracks which note the view's document belongs to, so a note SWITCH can be
  // told apart from an external change to the same note. They must be handled
  // differently or undo corrupts files (see the swap effect below).
  const docPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    docPathRef.current = getStore().activePath;
    const initialKey = `${getStore().vaultPath ?? ""}\0${docPathRef.current ?? ""}`;
    docKeyRef.current = initialKey;
    const initial = sessionsRef.current.get(initialKey);
    const view = new EditorView({
      parent: hostRef.current,
      state: initial?.state.doc.toString() === getStore().content ? initial.state : makeState(getStore().content, onUserEditRef.current),
    });
    if (initial) view.scrollDOM.scrollTop = initial.scrollTop;
    viewRef.current = view;
    return () => {
      if (docPathRef.current) rememberSession(docKeyRef.current, view.state, view.scrollDOM.scrollTop);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Restore history only for exact matching text and vault/document identity.
  // External replacements start fresh history, including same-note updates.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previousPath = docPathRef.current;
    const pathChanged = docKeyRef.current !== key;
    docPathRef.current = activePath;
    // Our own keystroke echoed back — the view already has this text.
    // (Identity check: the store holds the exact string we handed it.)
    if (!pathChanged && content === lastEditorTextRef.current) return;
    const next = content;
    const cur = view.state.doc.toString();
    if (pathChanged) {
      const oldKey = docKeyRef.current;
      docKeyRef.current = key;
      if (previousPath) rememberSession(oldKey, view.state, view.scrollDOM.scrollTop);
      const cached = sessionsRef.current.get(key);
      lastEditorTextRef.current = null;
      if (cached && cached.state.doc.toString() === next) {
        view.setState(cached.state);
        view.scrollDOM.scrollTop = cached.scrollTop;
      } else {
        view.setState(makeState(next, onUserEditRef.current, Boolean(activePath) && activeContentState === "ready"));
      }
    } else if (cur !== next) {
      lastEditorTextRef.current = null;
      const anchor = Math.min(view.state.selection.main.anchor, next.length);
      view.setState(makeState(next, onUserEditRef.current, Boolean(activePath) && activeContentState === "ready"));
      view.dispatch({ selection: { anchor } });
    }
  }, [key, activePath, activeContentState, content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(
      Boolean(activePath) && activeContentState === "ready"
    )) });
  }, [key, activePath, activeContentState]);

  // The host div is ALWAYS rendered so CodeMirror can mount even before the
  // first note is selected (the vault picks the first note a tick after the
  // editor mounts). The empty-state is an overlay, not a replacement.
  return (
    <div className="editor-wrap">
      <div className="editor-toolbar">
        <button
          className="seg-btn"
          onClick={() => getStore().openRevisionHistory()}
          title="Open revision history for this document"
          disabled={!activePath}
        >
          History
        </button>
        <button
          className={"seg-btn" + (outlineOpen ? " on" : "")}
          aria-pressed={outlineOpen}
          onClick={() => setOutlineOpen((open) => !open)}
          disabled={!activePath || activeContentState !== "ready"}
          title="Show document outline"
        >
          Outline
        </button>
        <div className="seg">
          <button
            className={"seg-btn" + (mode === "source" ? " on" : "")}
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
          >
            Source
          </button>
          <button
            className={"seg-btn" + (mode === "live" ? " on" : "")}
            aria-pressed={mode === "live"}
            onClick={() => setMode("live")}
          >
            Live
          </button>
        </div>
      </div>
      <div className={"editor-workspace " + mode + (outlineOpen ? " with-outline" : "")}>
        <div className="editor-host" ref={hostRef} />
        {activePath && activeContentState !== "ready" && (
          <div className="editor-load-state" role="status">
            <p>{activeContentState === "loading" ? "Loading document…" :
              activeContentState === "size-limit" ? "This file exceeds the 8 MiB automatic text limit." :
              "This document could not be read. Its content is unavailable."}</p>
            {activeContentState !== "loading" && <button className="btn" onClick={() => void loadActiveContent()}>
              {activeContentState === "size-limit" ? "Load file anyway" : "Retry read"}
            </button>}
          </div>
        )}
        {mode === "live" && (
          <aside className="editor-live-preview">
            <MarkdownView source={content} />
          </aside>
        )}
        {outlineOpen && (
          <nav className="editor-outline" aria-label="Document outline">
            {headings.map((heading) => (
              <button
                key={`${heading.line}-${heading.label}`}
                className="editor-outline-item"
                style={{ paddingInlineStart: `${8 + (heading.level - 1) * 12}px` }}
                onClick={() => goToHeading(heading.line)}
              >
                {heading.label}
              </button>
            ))}
          </nav>
        )}
      </div>
      {!activePath && (
        <div className="editor-empty">
          Select a note on the left, or create a new one.
        </div>
      )}
    </div>
  );
}
