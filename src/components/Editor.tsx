import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Annotation } from "@codemirror/state";
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

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: makeState(getStore().content, (text) => {
        lastEditorTextRef.current = text;
        getStore().setContentFromEditor(text);
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Swap the document when the active note or another Mesa surface changes it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Our own keystroke echoed back — the view already has this text.
    // (Identity check: the store holds the exact string we handed it.)
    if (content === lastEditorTextRef.current) return;
    const next = content;
    const cur = view.state.doc.toString();
    if (cur !== next) {
      lastEditorTextRef.current = null;
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: next },
        annotations: External.of(true),
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
            onClick={() => setMode("source")}
          >
            Source
          </button>
          <button
            className={"seg-btn" + (mode === "live" ? " on" : "")}
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
