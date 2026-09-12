import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Annotation, Transaction } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { useAppStore, getStore } from "../store";
import { MarkdownView } from "./MarkdownView";

// Marks programmatic document swaps so the change listener can ignore them
// (otherwise opening a note would register as "typing").
const External = Annotation.define<boolean>();

// Only structural styling lives here; all colors come from CSS variables in
// styles.css (.cm-editor rules) so the editor follows the active theme.
const editorLayout = EditorView.theme({
  "&": { height: "100%", fontSize: "15px" },
  ".cm-scroller": { overflow: "auto" },
});

function makeState(doc: string, onUserEdit: (text: string) => void): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      markdown(),
      editorLayout,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (u.transactions.some((t) => t.annotation(External))) return;
        onUserEdit(u.state.doc.toString());
      }),
    ],
  });
}

export function Editor() {
  const activePath = useAppStore((s) => s.activePath);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const content = useAppStore((s) => s.content);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The exact string we last pushed into the store from a user edit. When the
  // store echoes it back through the `content` subscription, we can skip the
  // doc-swap effect entirely — before this, EVERY keystroke serialized the
  // whole document a second time (view.state.doc.toString()) just to discover
  // nothing changed, which made typing in large notes feel sluggish.
  const lastEditorTextRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"source" | "live">("source");

  // CodeMirror owns the authoritative document and history while a note is
  // open. Keep a small vault-scoped LRU of states so switching notes does not
  // destroy undo, selection, or the editor's internal change history.
  type CachedSession = { key: string; state: EditorState; scrollTop: number; dirty: boolean; touched: number };
  const sessionsRef = useRef<Map<string, CachedSession>>(new Map());
  const touchRef = useRef(0);
  const sessionKey = (path: string | null) => `${vaultPath ?? ""}\0${path ?? ""}`;
  const rememberSession = (key: string, state: EditorState, scrollTop: number) => {
    const old = sessionsRef.current.get(key);
    const rel = key.slice(key.indexOf("\0") + 1);
    const stored = getStore().contentCache[rel];
    const dirty = stored === undefined ? (old?.dirty ?? false) : stored !== state.doc.toString();
    sessionsRef.current.set(key, { key, state, scrollTop, dirty, touched: ++touchRef.current });
    // Eight states and eight MiB of editor documents is a deliberate hard cap.
    // Dirty states are never evicted: their content exists only in memory.
    while (sessionsRef.current.size > 8 || [...sessionsRef.current.values()].reduce((n, s) => n + s.state.doc.length, 0) > 8 * 1024 * 1024) {
      const victim = [...sessionsRef.current.values()].filter((s) => !s.dirty).sort((a, b) => a.touched - b.touched)[0];
      if (!victim) break;
      sessionsRef.current.delete(victim.key);
    }
  };

  // One user-edit sink shared by the mount state and every per-note state.
  const onUserEditRef = useRef((text: string) => {
    lastEditorTextRef.current = text;
    const key = sessionKey(docPathRef.current);
    const cached = sessionsRef.current.get(key);
    if (cached) cached.dirty = true;
    else if (viewRef.current && docPathRef.current) {
      rememberSession(key, viewRef.current.state, viewRef.current.scrollDOM.scrollTop);
      sessionsRef.current.get(key)!.dirty = true;
    }
    getStore().setContentFromEditor(text);
  });

  // Tracks which note the view's document belongs to, so a note SWITCH can be
  // told apart from an external change to the same note. They must be handled
  // differently or undo corrupts files (see the swap effect below).
  const docPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    docPathRef.current = getStore().activePath;
    const initialKey = sessionKey(docPathRef.current);
    const initial = sessionsRef.current.get(initialKey);
    const view = new EditorView({
      parent: hostRef.current,
      state: initial?.state ?? makeState(getStore().content, onUserEditRef.current),
    });
    if (initial) view.scrollDOM.scrollTop = initial.scrollTop;
    viewRef.current = view;
    return () => {
      if (docPathRef.current) rememberSession(sessionKey(docPathRef.current), view.state, view.scrollDOM.scrollTop);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Swap the document when the active note or another Mesa surface changes it.
  //
  // UNDO MUST NEVER CROSS A DOCUMENT BOUNDARY. The view lives for the whole
  // app session, and a full-text replace transaction is undoable by default —
  // the `External` annotation only hides it from the change listener. That
  // combination silently corrupted files: open note A, switch to note B, press
  // Cmd+Z once more than there are B-local edits, and the undo reverts the
  // document swap itself — the editor shows A's text while `activePath` is B,
  // the undo registers as a user edit (undo transactions carry no External
  // annotation), `contentCache[B]` becomes A's text, and the debounced save
  // writes note A's content over note B on disk. Reproduced against the real
  // vault through the QA harness (the readonly bridge refused the final
  // write). So:
  //  - a note SWITCH replaces the whole EditorState — fresh history, nothing
  //    to undo into from the previous note (the in-note undo stack is
  //    deliberately dropped when you leave a note);
  //  - a same-note external refresh (watcher, agent write, async first read)
  //    dispatches with `addToHistory: false`, so undo cannot resurrect the
  //    stale pre-refresh text and save it back over the newer file.
  // Pinned by editorUndoBoundary.test.tsx.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previousPath = docPathRef.current;
    const pathChanged = previousPath !== activePath;
    docPathRef.current = activePath;
    // Our own keystroke echoed back — the view already has this text.
    // (Identity check: the store holds the exact string we handed it.)
    if (!pathChanged && content === lastEditorTextRef.current) return;
    const next = content;
    const cur = view.state.doc.toString();
    if (pathChanged) {
      const oldKey = sessionKey(previousPath);
      if (previousPath) rememberSession(oldKey, view.state, view.scrollDOM.scrollTop);
      const key = sessionKey(activePath);
      const cached = sessionsRef.current.get(key);
      lastEditorTextRef.current = null;
      if (cached) {
        cached.touched = ++touchRef.current;
        view.setState(cached.state);
        view.scrollDOM.scrollTop = cached.scrollTop;
      } else {
        view.setState(makeState(next, onUserEditRef.current));
      }
    } else if (cur !== next) {
      lastEditorTextRef.current = null;
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: next },
        annotations: [External.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [activePath, content]);

  // The host div is ALWAYS rendered so CodeMirror can mount even before the
  // first note is selected (the vault picks the first note a tick after the
  // editor mounts). The empty-state is an overlay, not a replacement.
  return (
    <div className="editor-wrap">
      <div className="editor-toolbar">
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
      <div className={"editor-workspace " + mode}>
        <div className="editor-host" ref={hostRef} />
        {mode === "live" && (
          <aside className="editor-live-preview">
            <MarkdownView source={content} />
          </aside>
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
